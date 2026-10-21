import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunError, type RunFile } from './exec.js';
import { createWorkedInScanner, type ScannerFs, type WorkedInScanner, type WorkedInScannerOptions } from './workedIn.js';

// Every transcript, path and repo here is made up.

const AT = Date.parse('2026-10-16T12:00:00.000Z');
const SESSION = '77777777-7777-4777-8777-777777777771';

let line = 0;
/** One assistant entry with one tool_use block, as Claude Code writes them, one per line. */
function call(name: string, input: Record<string, unknown>, cwd: string, minute = line): string {
  line++;
  return `${JSON.stringify({
    type: 'assistant',
    timestamp: new Date(AT + minute * 60_000).toISOString(),
    cwd,
    message: { id: `m${line}`, content: [{ type: 'tool_use', id: `t${line}`, name, input }] },
  })}\n`;
}
const bash = (command: string, cwd: string, minute?: number) => call('Bash', { command }, cwd, minute);
const read = (file: string, cwd: string, minute?: number) => call('Read', { file_path: file }, cwd, minute);
/** A line that isn't a tool call: a prompt, which the scanner never parses. */
const prompt = (text: string) => `${JSON.stringify({ type: 'user', timestamp: new Date(AT).toISOString(), message: { content: text } })}\n`;
/** `n` calls in `dir`, for padding a session's total. */
const calls = (n: number, dir: string) => Array.from({ length: n }, () => call('TodoWrite', { todos: [] }, dir)).join('');

interface GitCall {
  args: string[];
  cwd: string;
}

/**
 * A fake git: `rev-parse --git-common-dir` answers `<dir>/.git` for a directory holding a `.git`
 * directory, or the main repo's for a worktree's `.git` file; `config --get-regexp` answers the
 * remotes in `remotes`. It records every call, and how many ran at once.
 */
function fakeGit(remotes: Map<string, string[]> = new Map(), delayMs = 0) {
  const seen: GitCall[] = [];
  let running = 0;
  let peak = 0;
  const run: RunFile = async (file, args) => {
    expect(file).toBe('git');
    const cwd = args[1] ?? '';
    seen.push({ args: [...args], cwd });
    running++;
    peak = Math.max(peak, running);
    try {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (args[2] === 'rev-parse') {
        let dotGit: string;
        try {
          dotGit = await readFile(path.join(cwd, '.git'), 'utf8');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EISDIR') return `${path.join(cwd, '.git')}\n`;
          throw new RunError('exit', 'not a git repository', 128);
        }
        // A worktree: gitdir points at <main>/.git/worktrees/<name>.
        const gitdir = /gitdir: (.+)/.exec(dotGit)?.[1] ?? '';
        return `${path.dirname(path.dirname(gitdir))}\n`;
      }
      if (args[2] === 'config') {
        const urls = remotes.get(cwd);
        if (!urls || urls.length === 0) throw new RunError('exit', 'exited with code 1', 1);
        return urls.map((url, i) => `remote.r${i}.url ${url}\n`).join('');
      }
      throw new Error(`unexpected git ${args.join(' ')}`);
    } finally {
      running--;
    }
  };
  return { run, seen, peak: () => peak, revParses: () => seen.filter((c) => c.args[2] === 'rev-parse') };
}

describe('createWorkedInScanner', () => {
  let dir: string;
  let code: string;
  let projects: string;
  let main: string;
  let scanner: WorkedInScanner | undefined;
  /** The repos of the made-up root, each a directory with a `.git` directory. */
  const repo = (name: string) => path.join(code, name);

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pitwall-test-worked-in-')));
    code = path.join(dir, 'code');
    projects = path.join(dir, 'claude', 'projects', '-made-up');
    for (const name of ['app', 'api', 'docs', 'web']) await mkdir(path.join(repo(name), '.git'), { recursive: true });
    await mkdir(path.join(repo('app'), 'src'), { recursive: true });
    await mkdir(path.join(repo('api'), 'src'), { recursive: true });
    await mkdir(path.join(code, 'notes'), { recursive: true });
    await mkdir(projects, { recursive: true });
    main = path.join(projects, `${SESSION}.jsonl`);
  });

  afterEach(async () => {
    scanner?.stop();
    scanner = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  function start(options: WorkedInScannerOptions = {}) {
    scanner = createWorkedInScanner({ home: dir, ...options });
    return scanner;
  }

  /** Tracks one session started in `startKey`, waits for its scan, and returns its workedIn. */
  async function scan(s: WorkedInScanner, startKey = repo('app'), roots = [code], file: string | undefined = main) {
    s.track([{ sessionId: SESSION, file, startKey }], roots);
    await s.settled();
    return s.workedIn(SESSION);
  }

  const keys = (repos: readonly { key: string }[] | undefined) => repos?.map((r) => r.key);

  describe('the rule', () => {
    it('counts a repo the session changed, however few of its calls touched it', async () => {
      await writeFile(main, calls(99, repo('app')) + call('Edit', { file_path: path.join(repo('api'), 'src', 'a.ts') }, repo('app')));
      const git = fakeGit();
      expect(await scan(start({ run: git.run }))).toEqual([{ key: repo('api'), root: code, calls: 1, changes: 1, lastAt: expect.any(String) }]);
    });

    it('counts each kind of change: Edit, MultiEdit, Write, NotebookEdit, git commit, git push, gh pr create and gh pr merge', async () => {
      const git = fakeGit(new Map([[repo('web'), ['git@github.com:example-org/web.git']]]));
      const s = start({ run: git.run });
      const changes = [
        call('Edit', { file_path: path.join(repo('api'), 'a.ts') }, repo('app')),
        call('MultiEdit', { file_path: path.join(repo('api'), 'b.ts') }, repo('app')),
        call('Write', { file_path: path.join(repo('api'), 'c.ts') }, repo('app')),
        call('NotebookEdit', { notebook_path: path.join(repo('api'), 'd.ipynb') }, repo('app')),
        bash(`cd ${repo('api')} && git commit -m "made-up"`, repo('app')),
        bash('git push', repo('api')),
        bash('gh pr create --repo example-org/web --title t --body b', repo('app')),
        bash('gh pr merge 3 --squash', repo('api')),
      ];
      // Each kind on its own, among enough calls that no share passes 5%.
      for (const change of changes) {
        await writeFile(main, calls(200, repo('app')) + change);
        s.track([], [code]);
        const repos = await scan(s);
        expect(repos?.length, change).toBe(1);
        expect(repos?.[0]?.changes, change).toBe(1);
      }
    });

    it('counts a repo at 5% of the calls, and not below', async () => {
      const git = fakeGit();
      const s = start({ run: git.run });
      // 1 of 20 calls is 5%.
      await writeFile(main, calls(19, repo('app')) + read(path.join(repo('api'), 'README.md'), repo('app')));
      expect(keys(await scan(s))).toEqual([repo('api')]);
      // 1 of 21 is 4.8%.
      s.track([], [code]);
      await writeFile(main, calls(20, repo('app')) + read(path.join(repo('api'), 'README.md'), repo('app')));
      expect(await scan(s)).toEqual([]);
    });

    it('counts a call once for a repo, however many of its signals name it, and orders repos newest touch first', async () => {
      await writeFile(
        main,
        [
          bash(`cd ${repo('api')} && git -C ${repo('api')} log && ls`, repo('api'), 1),
          read(path.join(repo('docs'), 'a.md'), repo('app'), 3),
          read(path.join(repo('web'), 'a.md'), repo('app'), 2),
        ].join(''),
      );
      const repos = await scan(start({ run: fakeGit().run }));
      expect(repos?.map((r) => [path.basename(r.key), r.calls])).toEqual([
        ['docs', 1],
        ['web', 1],
        ['api', 1],
      ]);
      expect(repos?.[0]?.lastAt).toBe(new Date(AT + 3 * 60_000).toISOString());
    });

    it('has no cap on how many repos', async () => {
      await writeFile(main, ['api', 'docs', 'web'].map((name) => call('Edit', { file_path: path.join(repo(name), 'x') }, repo('app'))).join(''));
      expect(keys(await scan(start({ run: fakeGit().run })))?.sort()).toEqual([repo('api'), repo('docs'), repo('web')]);
    });
  });

  describe('the signals', () => {
    const only = async (lines: string, options: WorkedInScannerOptions = {}) => {
      await writeFile(main, lines);
      return keys(await scan(start({ run: fakeGit().run, ...options })));
    };

    it('file: a file tool’s path', async () => {
      expect(await only(read(path.join(repo('api'), 'src', 'server.ts'), repo('app')))).toEqual([repo('api')]);
    });

    it("cwd: the entry's working directory", async () => {
      expect(await only(call('TodoWrite', { todos: [] }, path.join(repo('api'), 'src')))).toEqual([repo('api')]);
    });

    it('cd: cd, pushd and git -C targets', async () => {
      expect(await only(bash(`cd ${repo('api')} && npm test`, repo('app')))).toEqual([repo('api')]);
      expect(await only(bash('pushd ../docs', repo('app')))).toEqual([repo('docs')]);
      expect(await only(bash(`git -C ${repo('web')} log`, repo('app')))).toEqual([repo('web')]);
    });

    it('gh: a GitHub repo matched to a local repo by its remotes', async () => {
      const git = fakeGit(new Map([[repo('api'), ['https://github.com/example-org/api.git', 'git@github.com:someone/api-fork.git']]]));
      expect(await only(bash('gh run list --repo example-org/api', repo('app')), { run: git.run })).toEqual([repo('api')]);
      expect(await only(call('WebFetch', { url: 'https://github.com/someone/api-fork/pulls' }, repo('app')), { run: git.run })).toEqual([repo('api')]);
      expect(await only(call('mcp__github__list_commits', { owner: 'example-org', repo: 'api' }, repo('app')), { run: git.run })).toEqual([repo('api')]);
      // Only read-only config reads for the remotes.
      expect(git.seen.filter((c) => c.args[2] === 'config').every((c) => c.args.join(' ') === `-C ${c.cwd} config --get-regexp ^remote\\..*\\.url$`)).toBe(true);
    });

    it('gh: a repo cloned twice goes to the clone named like it, else the first by path', async () => {
      await mkdir(path.join(code, 'web-old', '.git'), { recursive: true });
      const url = ['git@github.com:example-org/web.git'];
      const git = fakeGit(new Map([[repo('web'), url], [path.join(code, 'web-old'), url], [repo('docs'), ['git@github.com:example-org/site.git']], [repo('api'), ['git@github.com:example-org/site.git']]]));
      expect(await only(bash('gh pr list -R example-org/web', repo('app')), { run: git.run })).toEqual([repo('web')]);
      expect(await only(bash('gh pr list -R example-org/site', repo('app')), { run: git.run })).toEqual([repo('api')]);
    });

    it('gh: a repo with no local clone under a root counts for nothing', async () => {
      expect(await only(bash('gh pr list --repo example-org/elsewhere', repo('app')))).toEqual([]);
    });

    it('not: other absolute and relative paths in a command', async () => {
      expect(await only(bash(`cat ${repo('api')}/README.md ../docs/a.md`, repo('app')))).toEqual([]);
    });

    it('reads only lines that name a tool call', async () => {
      const parse = vi.spyOn(JSON, 'parse');
      try {
        expect(await only(prompt(`please look at ${repo('api')}`).repeat(5) + read(path.join(repo('docs'), 'a.md'), repo('app')))).toEqual([repo('docs')]);
        expect(parse.mock.calls.filter(([text]) => typeof text === 'string' && text.includes('"type":"user"'))).toHaveLength(0);
      } finally {
        parse.mockRestore();
      }
    });
  });

  describe('what it leaves out', () => {
    it('the repo the session started in', async () => {
      await writeFile(main, call('Edit', { file_path: path.join(repo('app'), 'src', 'a.ts') }, repo('app')) + call('Edit', { file_path: path.join(repo('api'), 'a.ts') }, repo('app')));
      expect(keys(await scan(start({ run: fakeGit().run }), repo('app')))).toEqual([repo('api')]);
    });

    it('the root itself, and directories in no repo', async () => {
      await writeFile(main, [call('Write', { file_path: path.join(code, 'notes', 'a.md') }, code), call('Write', { file_path: path.join(code, 'b.md') }, code), bash(`cd ${code}/notes`, code)].join(''));
      expect(await scan(start({ run: fakeGit().run }), code)).toEqual([]);
    });

    it('repos outside every root', async () => {
      const outside = path.join(dir, 'elsewhere', 'tool');
      await mkdir(path.join(outside, '.git'), { recursive: true });
      await writeFile(main, call('Edit', { file_path: path.join(outside, 'a.ts') }, repo('app')));
      const git = fakeGit();
      expect(await scan(start({ run: git.run }))).toEqual([]);
      // A main repo outside the roots is known from its `.git` directory: no git for it.
      expect(git.seen.filter((c) => c.cwd.startsWith(path.join(dir, 'elsewhere')))).toEqual([]);
    });

    it('but counts a worktree outside the roots whose repo is under one', async () => {
      const worktree = path.join(dir, 'scratch', 'api-feature');
      await mkdir(worktree, { recursive: true });
      await mkdir(path.join(repo('api'), '.git', 'worktrees', 'api-feature'), { recursive: true });
      await writeFile(path.join(worktree, '.git'), `gitdir: ${path.join(repo('api'), '.git', 'worktrees', 'api-feature')}\n`);
      await writeFile(main, call('Edit', { file_path: path.join(worktree, 'a.ts') }, repo('app')));
      expect(await scan(start({ run: fakeGit().run }))).toMatchObject([{ key: repo('api'), root: code, changes: 1 }]);
    });

    it('repos that no longer exist: a removed one, and one removed after its calls were counted', async () => {
      await writeFile(main, call('Edit', { file_path: path.join(code, 'removed', 'src', 'a.ts') }, repo('app')) + call('Edit', { file_path: path.join(repo('docs'), 'a.md') }, repo('app')));
      const s = start({ run: fakeGit().run });
      expect(keys(await scan(s))).toEqual([repo('docs')]);
      await rm(repo('docs'), { recursive: true });
      await appendFile(main, calls(1, repo('app')));
      expect(await scan(s)).toEqual([]);
    });

    it('a repo under another configured root, with that root', async () => {
      const work = path.join(dir, 'work');
      await mkdir(path.join(work, 'service', '.git'), { recursive: true });
      await writeFile(main, call('Edit', { file_path: path.join(work, 'service', 'a.ts') }, repo('app')));
      expect(await scan(start({ run: fakeGit().run }), repo('app'), [code, work])).toMatchObject([{ key: path.join(work, 'service'), root: work }]);
    });
  });

  describe('sub-agents', () => {
    const subagents = () => path.join(projects, SESSION, 'subagents');

    it('counts the calls in sub-agent transcripts, which share the call total', async () => {
      await mkdir(subagents(), { recursive: true });
      await writeFile(main, calls(10, repo('app')));
      // Only a sub-agent touched api: 1 of 20 calls, 5%.
      await writeFile(path.join(subagents(), 'agent-a1.jsonl'), calls(9, repo('app')) + bash(`cd ${repo('api')} && npm test`, repo('app')));
      await writeFile(path.join(subagents(), 'agent-a1.meta.json'), '{}');
      expect(await scan(start({ run: fakeGit().run }))).toMatchObject([{ key: repo('api'), calls: 1 }]);
    });

    it('picks up a sub-agent transcript that appears after the first scan', async () => {
      await writeFile(main, calls(5, repo('app')));
      const s = start({ run: fakeGit().run });
      expect(await scan(s)).toEqual([]);
      await mkdir(subagents(), { recursive: true });
      await writeFile(path.join(subagents(), 'agent-b2.jsonl'), call('Write', { file_path: path.join(repo('web'), 'a.ts') }, repo('app')));
      expect(await scan(s)).toMatchObject([{ key: repo('web'), changes: 1 }]);
    });

    it('drops the counts of a sub-agent transcript that has gone', async () => {
      await mkdir(subagents(), { recursive: true });
      await writeFile(main, calls(5, repo('app')));
      await writeFile(path.join(subagents(), 'agent-c3.jsonl'), call('Write', { file_path: path.join(repo('web'), 'a.ts') }, repo('app')));
      const s = start({ run: fakeGit().run });
      expect(keys(await scan(s))).toEqual([repo('web')]);
      await rm(path.join(subagents(), 'agent-c3.jsonl'));
      expect(await scan(s)).toEqual([]);
    });
  });

  describe('reading incrementally', () => {
    it('reads only what was appended since the last scan', async () => {
      await writeFile(main, calls(5, repo('app')));
      const s = start({ run: fakeGit().run });
      expect(await scan(s)).toEqual([]);
      const before = s.stats().bytesRead;
      const added = call('Edit', { file_path: path.join(repo('api'), 'a.ts') }, repo('app'));
      await appendFile(main, added);
      expect(await scan(s)).toMatchObject([{ key: repo('api'), calls: 1 }]);
      expect(s.stats().bytesRead - before).toBe(Buffer.byteLength(added));
      // Nothing new: nothing read.
      expect(await scan(s)).toMatchObject([{ key: repo('api'), calls: 1 }]);
      expect(s.stats().bytesRead - before).toBe(Buffer.byteLength(added));
    });

    it('finishes a partial last line once the rest is written', async () => {
      const whole = call('Edit', { file_path: path.join(repo('api'), 'a.ts') }, repo('app'));
      await writeFile(main, calls(3, repo('app')) + whole.slice(0, 40));
      const s = start({ run: fakeGit().run });
      expect(await scan(s)).toEqual([]);
      await appendFile(main, whole.slice(40));
      expect(await scan(s)).toMatchObject([{ key: repo('api'), calls: 1, changes: 1 }]);
    });

    it('rescans from the start a file that shrank, without counting anything twice', async () => {
      await writeFile(main, call('Edit', { file_path: path.join(repo('api'), 'a.ts') }, repo('app')) + calls(5, repo('app')));
      const s = start({ run: fakeGit().run });
      expect(await scan(s)).toMatchObject([{ key: repo('api'), calls: 1 }]);
      await writeFile(main, call('Edit', { file_path: path.join(repo('docs'), 'a.md') }, repo('app')));
      expect(await scan(s)).toMatchObject([{ key: repo('docs'), calls: 1 }]);
    });

    it('rescans from the start a file that was replaced, even when it grew', async () => {
      await writeFile(main, call('Edit', { file_path: path.join(repo('api'), 'a.ts') }, repo('app')));
      const s = start({ run: fakeGit().run });
      expect(await scan(s)).toMatchObject([{ key: repo('api'), calls: 1 }]);
      const next = path.join(projects, 'next.tmp');
      await writeFile(next, calls(3, repo('app')) + call('Edit', { file_path: path.join(repo('web'), 'a.ts') }, repo('app')));
      await rename(next, main);
      expect(await scan(s)).toMatchObject([{ key: repo('web'), calls: 1 }]);
    });

    it('reads in chunks, a line split across them included, and skips a line too long to keep', async () => {
      const long = call('Write', { file_path: path.join(repo('web'), 'a.ts'), content: 'x'.repeat(4000) }, repo('app'));
      await writeFile(main, calls(2, repo('app')) + long + call('Edit', { file_path: path.join(repo('api'), 'a.ts') }, repo('app')));
      expect(keys(await scan(start({ run: fakeGit().run, chunkBytes: 64 })))?.sort()).toEqual([repo('api'), repo('web')]);
      scanner?.stop();
      expect(keys(await scan(start({ run: fakeGit().run, chunkBytes: 64, maxLineBytes: 1024 })))).toEqual([repo('api')]);
    });
  });

  describe('git', () => {
    it('runs only at repo boundaries, once each, and reuses the answer', async () => {
      await mkdir(path.join(repo('api'), 'src', 'deep', 'er'), { recursive: true });
      const lines = ['src', 'src/deep', 'src/deep/er', '.'].map((sub) => read(path.join(repo('api'), sub, 'f.ts'), repo('app'))).join('');
      await writeFile(main, lines + bash(`cd ${code}/notes && ls`, repo('app')));
      const git = fakeGit();
      const s = start({ run: git.run });
      await scan(s);
      // One for app (the cwd) and one for api, from its top-level directory; none for notes, the root or above.
      expect(git.revParses().map((c) => c.cwd).sort()).toEqual([repo('api'), repo('app')]);
      await appendFile(main, lines);
      await scan(s);
      expect(git.revParses()).toHaveLength(2);
    });

    it('runs at most 2 git processes at once', async () => {
      const remotes = new Map(['app', 'api', 'docs', 'web'].map((name) => [repo(name), [`git@github.com:example-org/${name}.git`]]));
      const git = fakeGit(remotes, 20);
      await writeFile(main, ['api', 'docs', 'web'].map((name) => read(path.join(repo(name), 'a'), repo('app'))).join('') + bash('gh pr list -R example-org/web', repo('app')));
      await scan(start({ run: git.run }));
      expect(git.seen.length).toBeGreaterThan(4);
      expect(git.peak()).toBe(2);
      expect(scanner?.stats()).toMatchObject({ gitRuns: git.seen.length, gitPeak: 2 });
    });

    it('reads remotes only once a GitHub reference needs them', async () => {
      await writeFile(main, read(path.join(repo('api'), 'a'), repo('app')));
      const git = fakeGit();
      await scan(start({ run: git.run }));
      expect(git.seen.filter((c) => c.args[2] === 'config')).toEqual([]);
    });

    it('treats a directory git fails in as no repo, and carries on', async () => {
      const failing: RunFile = async () => {
        throw new RunError('timeout', 'timed out after 5s');
      };
      await writeFile(main, call('Edit', { file_path: path.join(repo('api'), 'a.ts') }, repo('app')) + bash('gh pr list -R example-org/api', repo('app')));
      expect(await scan(start({ run: failing }))).toEqual([]);
    });
  });

  describe('failing soft', () => {
    it('has no workedIn for a session with no transcript, or whose transcript has gone', async () => {
      const s = start({ run: fakeGit().run });
      expect(await scan(s, repo('app'), [code], undefined)).toBeUndefined();
      expect(await scan(s, repo('app'), [code], path.join(projects, 'missing.jsonl'))).toBeUndefined();
      await writeFile(main, call('Edit', { file_path: path.join(repo('api'), 'a.ts') }, repo('app')));
      const t = start({ run: fakeGit().run, retryMs: 0 });
      expect(keys(await scan(t))).toEqual([repo('api')]);
      await rm(main);
      expect(await scan(t)).toBeUndefined();
    });

    it('has no workedIn for a transcript that can’t be read, and tries again later', async () => {
      await writeFile(main, call('Edit', { file_path: path.join(repo('api'), 'a.ts') }, repo('app')));
      let refuse = true;
      const fs: Partial<ScannerFs> = {
        open: async (file) => {
          if (refuse && file === main) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
          const { open } = await import('node:fs/promises');
          return open(file, 'r');
        },
      };
      let clock = AT;
      const s = start({ run: fakeGit().run, fs, now: () => clock, retryMs: 30_000 });
      expect(await scan(s)).toBeUndefined();
      refuse = false;
      // Not before the retry delay.
      expect(await scan(s)).toBeUndefined();
      clock += 30_000;
      expect(keys(await scan(s))).toEqual([repo('api')]);
    });

    it('has no workedIn for a transcript path that is a directory', async () => {
      await mkdir(path.join(projects, 'odd.jsonl'));
      expect(await scan(start({ run: fakeGit().run }), repo('app'), [code], path.join(projects, 'odd.jsonl'))).toBeUndefined();
    });

    it('skips lines that are not JSON and entries that are not what it expects', async () => {
      await writeFile(main, '{"type":"tool_use" not json\n' + `${JSON.stringify({ type: 'assistant', message: { content: 'text', note: '"type":"tool_use"' } })}\n` + read(path.join(repo('api'), 'a'), repo('app')));
      expect(keys(await scan(start({ run: fakeGit().run })))).toEqual([repo('api')]);
    });

    it('never throws from track, even for sessions it can’t read', () => {
      const s = start({ run: fakeGit().run });
      expect(() => s.track([{ sessionId: SESSION, file: '/nowhere/at/all.jsonl', startKey: '/nowhere' }], [code])).not.toThrow();
    });
  });

  describe('its sessions', () => {
    it('answers at once, before any scan has run, and forgets a session once it is no longer listed', async () => {
      await writeFile(main, call('Edit', { file_path: path.join(repo('api'), 'a.ts') }, repo('app')));
      const s = start({ run: fakeGit().run });
      s.track([{ sessionId: SESSION, file: main, startKey: repo('app') }], [code]);
      expect(s.workedIn(SESSION)).toBeUndefined();
      await s.settled();
      expect(keys(s.workedIn(SESSION))).toEqual([repo('api')]);
      s.track([], [code]);
      expect(s.workedIn(SESSION)).toBeUndefined();
    });

    it('leaves out the start repo as of the latest track', async () => {
      await writeFile(main, call('Edit', { file_path: path.join(repo('api'), 'a.ts') }, repo('app')));
      const s = start({ run: fakeGit().run });
      expect(keys(await scan(s, repo('app')))).toEqual([repo('api')]);
      s.track([{ sessionId: SESSION, file: main, startKey: repo('api') }], [code]);
      expect(s.workedIn(SESSION)).toEqual([]);
    });

    it('scans one session at a time, the ones it has scanned before first', async () => {
      const other = path.join(projects, '77777777-7777-4777-8777-777777777772.jsonl');
      await writeFile(main, calls(3, repo('app')));
      await writeFile(other, call('Edit', { file_path: path.join(repo('api'), 'a.ts') }, repo('app')));
      const opened: string[] = [];
      const fs: Partial<ScannerFs> = {
        open: async (file) => {
          opened.push(path.basename(file));
          const { open } = await import('node:fs/promises');
          return open(file, 'r');
        },
      };
      const s = start({ run: fakeGit().run, fs });
      s.track([{ sessionId: SESSION, file: main, startKey: repo('app') }], [code]);
      await s.settled();
      opened.length = 0;
      s.track([{ sessionId: 'second', file: other, startKey: repo('app') }, { sessionId: SESSION, file: main, startKey: repo('app') }], [code]);
      await s.settled();
      expect(opened).toEqual([path.basename(main), path.basename(other)]);
    });
  });
});

describe('createWorkedInScanner against a real git repo', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pitwall-test-worked-in-git-')));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('resolves a worktree to its repo and matches a GitHub reference by the remote git reports', async () => {
    const code = path.join(dir, 'code');
    const api = path.join(code, 'api');
    await mkdir(api, { recursive: true });
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=pitwall-test', '-c', 'user.email=pitwall-test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, stdio: 'ignore' });
    git(api, 'init', '-q');
    git(api, 'commit', '-q', '--allow-empty', '-m', 'init');
    git(api, 'remote', 'add', 'origin', 'git@github.com:example-org/api.git');
    const worktree = path.join(code, 'api-worktrees', 'feature');
    git(api, 'worktree', 'add', '-q', '-b', 'feature', worktree);
    const file = path.join(dir, 'session.jsonl');
    await writeFile(file, call('Edit', { file_path: path.join(worktree, 'a.ts') }, code) + bash('gh pr view 1 --repo example-org/api', code));
    const scanner = createWorkedInScanner({ home: dir });
    scanner.track([{ sessionId: SESSION, file, startKey: code }], [code]);
    await scanner.settled();
    expect(scanner.workedIn(SESSION)).toMatchObject([{ key: api, root: code, calls: 2, changes: 1 }]);
    scanner.stop();
  }, 20_000);
});
