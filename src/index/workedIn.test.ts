import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PR_LINKS_MAX } from '../shared/protocol.js';
import { RunError, type RunFile } from './exec.js';
import { addLink, newestLinks, toPrLink, type FoundLink } from './prLinks.js';
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

    it("reads a worktree's .git file with spaces and a CRLF after its path, and none from a blank one", async () => {
      const worktree = path.join(dir, 'scratch', 'api-feature');
      const blank = path.join(dir, 'scratch', 'api-blank');
      await mkdir(worktree, { recursive: true });
      await mkdir(blank, { recursive: true });
      await mkdir(path.join(repo('api'), '.git', 'worktrees', 'api-feature'), { recursive: true });
      await writeFile(path.join(worktree, '.git'), `gitdir: ${path.join(repo('api'), '.git', 'worktrees', 'api-feature')}   \r\n`);
      await writeFile(path.join(blank, '.git'), 'gitdir:   \n');
      await writeFile(main, call('Edit', { file_path: path.join(worktree, 'a.ts') }, repo('app')) + call('Edit', { file_path: path.join(blank, 'a.ts') }, repo('app')));
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

    it('a removed repo below a root that is itself inside a repo, which would otherwise count for the enclosing repo', async () => {
      const outer = path.join(dir, 'outer');
      const root = path.join(outer, 'code');
      await mkdir(path.join(outer, '.git'), { recursive: true });
      await mkdir(path.join(root, 'kept'), { recursive: true });
      await writeFile(main, call('Edit', { file_path: path.join(root, 'removed-repo', 'src', 'a.ts') }, root) + call('Edit', { file_path: path.join(root, 'kept', 'b.ts') }, root));
      // Both calls ran in the root, which is in the enclosing repo, so both touch it. The edit in a directory that's there
      // changes it, as the root's own group is that repo; the edit in the removed repo changes nothing.
      expect(await scan(start({ run: fakeGit().run }), path.join(dir, 'elsewhere'), [root])).toMatchObject([{ key: outer, root, calls: 2, changes: 1 }]);
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

  describe('PR links (W94)', () => {
    const APP = 'https://github.com/example/demo-app';
    const API = 'https://github.com/example/demo-api';
    const time = (minute: number) => new Date(AT + minute * 60_000).toISOString();
    const subagents = () => path.join(projects, SESSION, 'subagents');
    let next = 0;

    /** A tool call, as Claude Code writes one, and its id. */
    function use(name: string, input: unknown, minute: number, extra: Record<string, unknown> = {}): { line: string; id: string } {
      const id = `toolu_made_up_${++next}`;
      const entry = { type: 'assistant', timestamp: time(minute), cwd: repo('app'), ...extra, message: { id: `msg_${next}`, content: [{ type: 'tool_use', id, name, input }] } };
      return { id, line: `${JSON.stringify(entry)}\n` };
    }
    /** A tool's result, on its own line, as Claude Code writes them. */
    function result(id: string, content: unknown, minute: number, options: { error?: boolean; extra?: Record<string, unknown> } = {}): string {
      const block = { tool_use_id: id, type: 'tool_result', content, ...(options.error === undefined ? {} : { is_error: options.error }) };
      return `${JSON.stringify({ type: 'user', timestamp: time(minute), ...options.extra, message: { role: 'user', content: [block] } })}\n`;
    }
    /** A Bash call and its result a minute later. */
    function ran(command: string, output: string, minute: number, options: { error?: boolean; extra?: Record<string, unknown> } = {}): string {
      const { id, line } = use('Bash', { command }, minute, options.extra);
      return line + result(id, output, minute + 1, options);
    }
    /** Claude's text, on its own line. */
    const said = (text: string, minute: number, extra: Record<string, unknown> = {}) =>
      `${JSON.stringify({ type: 'assistant', timestamp: time(minute), ...extra, message: { id: `msg_said_${++next}`, content: [{ type: 'text', text }] } })}\n`;
    /** Claude's text and a tool call on one line, as the API returns a message. */
    const saidAndUsed = (text: string, minute: number, extra: Record<string, unknown> = {}) =>
      `${JSON.stringify({ type: 'assistant', timestamp: time(minute), cwd: repo('app'), ...extra, message: { id: `msg_both_${++next}`, content: [{ type: 'text', text }, { type: 'tool_use', id: `toolu_both_${next}`, name: 'Read', input: { file_path: path.join(repo('app'), 'a.ts') } }] } })}\n`;
    /** A prompt you typed. */
    const typed = (content: unknown, minute: number, extra: Record<string, unknown> = {}) =>
      `${JSON.stringify({ type: 'user', timestamp: time(minute), promptSource: 'typed', ...extra, message: { role: 'user', content } })}\n`;

    const ghCreated = (n: number, repoUrl = APP) => `Creating pull request for feature/one into main in example/demo-app\n\n${repoUrl}/pull/${n}\n`;
    const pushedNew = (branch: string, remote = `${APP}.git`) =>
      ['remote: ', `remote: Create a pull request for '${branch}' on GitHub by visiting:`, `remote:      ${APP}/pull/new/${branch}`, 'remote: ', `To ${remote}`, ` * [new branch]      ${branch} -> ${branch}`, ''].join('\n');

    async function links(s: WorkedInScanner = start({ run: fakeGit().run })) {
      s.track([{ sessionId: SESSION, file: main, startKey: repo('app') }], [code]);
      await s.settled();
      return s.prLinks(SESSION);
    }

    it('opened: the URL gh pr create printed, and the first a GitHub MCP create_pull_request tool returned', async () => {
      const mcp = use('mcp__github__create_pull_request', { owner: 'example', repo: 'demo-api', title: 't', head: 'feature/two', base: 'main' }, 3);
      const rest = { url: 'https://api.github.com/repos/example/demo-api/pulls/7', html_url: `${API}/pull/7`, body: `Follows ${API}/pull/6` };
      await writeFile(main, ran('gh pr create --title "A made-up title" --body b', ghCreated(12), 1) + mcp.line + result(mcp.id, [{ type: 'text', text: JSON.stringify(rest) }], 4));
      expect(await links()).toEqual([
        { kind: 'opened', repo: 'example/demo-api', number: 7, lastAt: time(4) },
        { kind: 'opened', repo: 'example/demo-app', number: 12, lastAt: time(2) },
      ]);
    });

    it('pushed: each branch a git push pushed, under the GitHub repo its To line names, with gh pr create in the same command', async () => {
      const both = `${pushedNew('feature/one')}\n${APP}/pull/12\n`;
      const twoRemotes = ['To github.com:example/demo-app.git', '   1a2b3c4..5d6e7f8  main -> main', `To git@github.com:example/demo-api.git`, ' + 1a2b3c4...5d6e7f8 feature/two -> feature/two (forced update)', ''].join('\n');
      await writeFile(main, ran('git push -u origin feature/one && gh pr create --fill', both, 1) + ran('git push origin main && git push upstream +feature/two', twoRemotes, 5));
      expect(await links()).toEqual([
        { kind: 'pushed', repo: 'example/demo-api', branch: 'feature/two', lastAt: time(6) },
        { kind: 'pushed', repo: 'example/demo-app', branch: 'main', lastAt: time(6) },
        { kind: 'opened', repo: 'example/demo-app', number: 12, lastAt: time(2) },
        { kind: 'pushed', repo: 'example/demo-app', branch: 'feature/one', lastAt: time(2) },
      ]);
    });

    it('pushed: none for rejected, deleted or up-to-date refs, tags, or a remote that is not GitHub', async () => {
      const output = [`To ${APP}.git`, ' ! [rejected]        main -> main (fetch first)', ' - [deleted]         feature/old', ' = [up to date]      feature/two -> feature/two', ' * [new tag]         v1 -> v1', 'To gitlab.com:example/demo-app.git', ' * [new branch]      feature/x -> feature/x', ''].join('\n');
      await writeFile(main, ran('git push --all; git push --tags; true', output, 1) + ran('git push', 'Everything up-to-date\n', 3));
      expect(await links()).toEqual([]);
    });

    it('prompted: a PR URL in a prompt you typed, as a string or text blocks, system reminders aside', async () => {
      await writeFile(
        main,
        typed(`please review ${APP}/pull/12/files and https://github.com/Example/Demo-API/pull/3#discussion_r1`, 1) +
          typed([{ type: 'text', text: `<system-reminder>${APP}/pull/99</system-reminder>\nnow ${APP}/pull/13` }], 2),
      );
      expect(await links()).toEqual([
        { kind: 'prompted', repo: 'example/demo-app', number: 13, lastAt: time(2) },
        { kind: 'prompted', repo: 'example/demo-api', number: 3, lastAt: time(1) },
        { kind: 'prompted', repo: 'example/demo-app', number: 12, lastAt: time(1) },
      ]);
    });

    it('prompted: not from messages from other sessions, meta lines, task notices, compact summaries or command output', async () => {
      await writeFile(
        main,
        [
          typed(`Another Claude session sent a message:\n${APP}/pull/1`, 1),
          typed(`<cross-session-message from="made-up">${APP}/pull/2</cross-session-message>`, 1),
          typed(`${APP}/pull/3`, 1, { origin: { kind: 'peer' } }),
          typed(`${APP}/pull/4`, 1, { isMeta: true }),
          typed(`<task-notification>${APP}/pull/5</task-notification>`, 1),
          typed(`${APP}/pull/6`, 1, { isCompactSummary: true }),
          typed(`<bash-stdout>${APP}/pull/7</bash-stdout>`, 1),
          typed(`<local-command-stdout>${APP}/pull/8</local-command-stdout>`, 1),
        ].join(''),
      );
      expect(await links()).toEqual([]);
    });

    it('prompted: a PR URL in a prompt you typed while Claude worked, not in a message or task notice that arrived then (W99)', async () => {
      /** What arrived mid-turn: a queued_command attachment, with no user entry. */
      const queued = (prompt: unknown, minute: number, attachment: Record<string, unknown>) =>
        `${JSON.stringify({ type: 'attachment', timestamp: time(minute), attachment: { type: 'queued_command', prompt, commandMode: 'prompt', ...attachment } })}\n`;
      await writeFile(
        main,
        [
          queued(`also look at ${APP}/pull/14`, 1, { origin: { kind: 'human' }, humanTurn: true }),
          queued([{ type: 'text', text: `and ${API}/pull/4` }, { type: 'image', source: {} }], 2, { origin: { kind: 'human' } }),
          queued(`<cross-session-message from="uds:/tmp/made-up.sock">${APP}/pull/1</cross-session-message>`, 3, { isMeta: true, origin: { kind: 'peer' } }),
          queued(`<task-notification>${APP}/pull/2</task-notification>`, 3, { commandMode: 'task-notification', origin: { kind: 'task-notification' } }),
          queued(`${APP}/pull/3`, 3, { commandMode: 'bash', origin: { kind: 'human' } }),
        ].join(''),
      );
      expect(await links()).toEqual([
        { kind: 'prompted', repo: 'example/demo-api', number: 4, lastAt: time(2) },
        { kind: 'prompted', repo: 'example/demo-app', number: 14, lastAt: time(1) },
      ]);
    });

    it("mentioned: a PR URL in Claude's own text, newest of each, not in its thinking or tool input", async () => {
      const view = use('Bash', { command: `gh pr view ${APP}/pull/20` }, 3);
      const thinking = `${JSON.stringify({ type: 'assistant', timestamp: time(4), message: { id: 'm-think', content: [{ type: 'thinking', thinking: `${APP}/pull/21` }] } })}\n`;
      await writeFile(main, said(`Opened [#12](${APP}/pull/12).`, 1) + said(`${APP}/pull/12 is green now`, 5) + view.line + thinking + said('No links here.', 6) + saidAndUsed(`Reading ${API}/pull/2`, 7));
      expect(await links()).toEqual([
        { kind: 'mentioned', repo: 'example/demo-api', number: 2, lastAt: time(7) },
        { kind: 'mentioned', repo: 'example/demo-app', number: 12, lastAt: time(5) },
      ]);
    });

    it('counts no PR URL in tool output: gh pr list, a file read, git push’s remote lines, or a sub-agent’s report', async () => {
      const read = use('Read', { file_path: path.join(repo('app'), 'NOTES.md') }, 3);
      const agent = use('Agent', { description: 'made-up', prompt: `look at ${APP}/pull/30` }, 5);
      const existing = [`remote: View pull request for feature/one => ${APP}/pull/31`, `To ${APP}.git`, '   1a2b3c4..5d6e7f8  feature/one -> feature/one', ''].join('\n');
      await writeFile(
        main,
        ran('gh pr list', `${APP}/pull/1\n${APP}/pull/2\n`, 1) +
          read.line +
          result(read.id, `see ${APP}/pull/3\n${APP}/pull/4`, 4) +
          agent.line +
          result(agent.id, [{ type: 'text', text: `Done: ${APP}/pull/32` }], 6) +
          ran('git push', existing, 7),
      );
      expect(await links()).toEqual([{ kind: 'pushed', repo: 'example/demo-app', branch: 'feature/one', lastAt: time(8) }]);
    });

    it("opens nothing from a failed result, nor from a call whose result never came, but takes a failed push's accepted refs", async () => {
      const exists = `a pull request for branch "feature/one" into branch "main" already exists:\n${APP}/pull/12\n`;
      const mcp = use('mcp__github__create_pull_request', { owner: 'example', repo: 'demo-app' }, 5);
      const interrupted = use('Bash', { command: 'gh pr create --fill' }, 7);
      const rejected = [`To ${APP}.git`, ' ! [rejected]        main -> main (fetch first)', ' ! [rejected]        feature/two -> feature/two (atomic push failed)', "error: failed to push some refs to 'https://github.com/example/demo-app.git'", ''].join('\n');
      await writeFile(
        main,
        // The push went through and gh failed, as the PR already exists: pushed, not opened.
        ran('git push -u origin feature/one && gh pr create --fill', `Exit code 1\n${pushedNew('feature/one')}${exists}`, 1, { error: true }) +
          // The push went through and the tests after it failed.
          ran('git push origin feature/three && npm test', `Exit code 1\n${pushedNew('feature/three')}made-up test failure\n`, 3, { error: true }) +
          ran('git push --atomic origin main feature/two', `Exit code 1\n${rejected}`, 11, { error: true }) +
          mcp.line +
          result(mcp.id, [{ type: 'text', text: `${APP}/pull/13` }], 6, { error: true }) +
          interrupted.line +
          result(interrupted.id, '[Request interrupted by user for tool use]', 8, { error: true }) +
          use('Bash', { command: 'gh pr create --fill' }, 9).line +
          typed('a made-up prompt', 10),
      );
      expect(await links()).toEqual([
        { kind: 'pushed', repo: 'example/demo-app', branch: 'feature/three', lastAt: time(4) },
        { kind: 'pushed', repo: 'example/demo-app', branch: 'feature/one', lastAt: time(2) },
      ]);
    });

    it('drops a link with no time, but gives a result without one its call’s time', async () => {
      const create = use('Bash', { command: 'gh pr create --fill' }, 1);
      const untimed = use('Bash', { command: 'gh pr create --fill' }, 3);
      const noTime = (line: string) => `${JSON.stringify({ ...JSON.parse(line), timestamp: undefined })}\n`;
      await writeFile(
        main,
        noTime(typed(`${APP}/pull/5`, 0)) +
          `${JSON.stringify({ type: 'assistant', timestamp: 'not a time', message: { id: 'm-untimed', content: [{ type: 'text', text: `${APP}/pull/6` }] } })}\n` +
          create.line +
          noTime(result(create.id, ghCreated(12), 2)) +
          noTime(untimed.line) +
          noTime(result(untimed.id, ghCreated(13), 4)),
      );
      expect(await links()).toEqual([{ kind: 'opened', repo: 'example/demo-app', number: 12, lastAt: time(1) }]);
    });

    it('prunes a file past 80 links to what the result keeps, and keeps what merging them whole would', async () => {
      const lines: string[] = [];
      const found = new Map<string, FoundLink>();
      // 300 lines with times out of order and repeats, some newer than when they were pruned.
      for (let i = 0; i < 300; i++) {
        const minute = (i * 37) % 211;
        const number = ((i * 13) % 140) + 1;
        if (i % 3 === 0) {
          lines.push(said(`${API}/pull/${number}`, minute));
          addLink(found, { kind: 'mentioned', repo: 'example/demo-api', number, at: AT + minute * 60_000 });
        } else {
          lines.push(typed(`${APP}/pull/${number}`, minute));
          addLink(found, { kind: 'prompted', repo: 'example/demo-app', number, at: AT + minute * 60_000 });
        }
      }
      expect(found.size).toBeGreaterThan(80);
      await writeFile(main, lines.join(''));
      expect(await links()).toEqual(newestLinks(found.values()).map(toPrLink));
    });

    it('stops waiting on a call after 10,000 lines without its result', async () => {
      const filler = (n: number) => `${JSON.stringify({ type: 'progress', timestamp: time(2) })}\n`.repeat(n);
      const late = use('Bash', { command: 'gh pr create --fill' }, 1);
      const inTime = use('Bash', { command: 'gh pr create --fill' }, 3);
      await writeFile(main, late.line + filler(10_000) + inTime.line + filler(9_998) + result(inTime.id, ghCreated(13), 4) + result(late.id, ghCreated(12), 4));
      expect(await links()).toEqual([{ kind: 'opened', repo: 'example/demo-app', number: 13, lastAt: time(4) }]);
    });

    it('waits on at most 32 calls at once, dropping the oldest', async () => {
      const waiting = Array.from({ length: 33 }, (_, i) => use('mcp__github__create_pull_request', {}, i));
      await writeFile(main, waiting.map((w) => w.line).join('') + waiting.map((w, i) => result(w.id, `${APP}/pull/${i + 1}`, 50)).join(''));
      // The 32 it waited for, of which the cap keeps 20; all have the same time, so lowest number first.
      expect(((await links()) ?? []).map((l) => l.number)).toEqual(Array.from({ length: PR_LINKS_MAX }, (_, i) => i + 2));
    });

    it('sub-agents: counts what one opened and pushed, not its prompts or its text', async () => {
      await mkdir(subagents(), { recursive: true });
      await writeFile(main, typed('a made-up prompt', 1));
      const sidechain = { isSidechain: true, agentId: 'a1' };
      await writeFile(
        path.join(subagents(), 'agent-a1.jsonl'),
        // A sub-agent's "user" lines are its parent's prompt: without isSidechain too, they don't count.
        typed(`work on ${API}/pull/40`, 2) +
          typed(`and ${API}/pull/41`, 2, sidechain) +
          said(`Opened ${API}/pull/42`, 9) +
          saidAndUsed(`Reading ${API}/pull/43`, 9) +
          ran('git push -u origin feature/two', pushedNew('feature/two', `${API}.git`), 3, { extra: sidechain }) +
          ran('gh pr create --fill', ghCreated(42, API), 5, { extra: sidechain }),
      );
      expect(await links()).toEqual([
        { kind: 'opened', repo: 'example/demo-api', number: 42, lastAt: time(6) },
        { kind: 'pushed', repo: 'example/demo-api', branch: 'feature/two', lastAt: time(4) },
      ]);
    });

    it('keeps the newest of a link found in more than one file', async () => {
      await mkdir(subagents(), { recursive: true });
      await writeFile(main, ran('git push', pushedNew('feature/one'), 1));
      await writeFile(path.join(subagents(), 'agent-a1.jsonl'), ran('git push', pushedNew('feature/one'), 7));
      await writeFile(path.join(subagents(), 'agent-a2.jsonl'), ran('git push', pushedNew('feature/one'), 4));
      expect(await links()).toEqual([{ kind: 'pushed', repo: 'example/demo-app', branch: 'feature/one', lastAt: time(8) }]);
    });

    it('is empty for a scanned session with no links, and undefined before its first scan', async () => {
      await writeFile(main, typed('a made-up prompt', 1) + said('a made-up reply', 2));
      const s = start({ run: fakeGit().run });
      s.track([{ sessionId: SESSION, file: main, startKey: repo('app') }], [code]);
      expect(s.prLinks(SESSION)).toBeUndefined();
      await s.settled();
      expect(s.prLinks(SESSION)).toEqual([]);
      s.track([], [code]);
      expect(s.prLinks(SESSION)).toBeUndefined();
    });

    it('reads appended lines only, a result written after its call included, and a line split across reads', async () => {
      const create = use('Bash', { command: 'gh pr create --fill' }, 1);
      await writeFile(main, create.line);
      const s = start({ run: fakeGit().run, chunkBytes: 64 });
      expect(await links(s)).toEqual([]);
      const before = s.stats().bytesRead;
      const added = result(create.id, ghCreated(12), 2) + said(`${APP}/pull/12 is up`, 3);
      await appendFile(main, added.slice(0, 50));
      expect(await links(s)).toEqual([]);
      await appendFile(main, added.slice(50));
      expect(await links(s)).toEqual([
        { kind: 'mentioned', repo: 'example/demo-app', number: 12, lastAt: time(3) },
        { kind: 'opened', repo: 'example/demo-app', number: 12, lastAt: time(2) },
      ]);
      expect(s.stats().bytesRead - before).toBe(Buffer.byteLength(added));
    });

    it('rescans a file that shrank or was replaced, without keeping its old links or counting any twice', async () => {
      await writeFile(main, ran('gh pr create --fill', ghCreated(12), 1) + typed(`${APP}/pull/5`, 3));
      const s = start({ run: fakeGit().run });
      expect((await links(s))?.map((l) => [l.kind, l.number])).toEqual([
        ['prompted', 5],
        ['opened', 12],
      ]);
      await writeFile(main, typed(`${APP}/pull/6`, 4));
      expect(await links(s)).toEqual([{ kind: 'prompted', repo: 'example/demo-app', number: 6, lastAt: time(4) }]);
      const replacement = path.join(projects, 'next.tmp');
      await writeFile(replacement, `${typed('a made-up prompt that pads the file past its old size', 1).repeat(3)}${ran('gh pr create --fill', ghCreated(13), 5)}`);
      await rename(replacement, main);
      expect(await links(s)).toEqual([{ kind: 'opened', repo: 'example/demo-app', number: 13, lastAt: time(6) }]);
    });

    it(`keeps at most ${PR_LINKS_MAX}, newest first, dropping the oldest mentioned links first`, async () => {
      const prompts = Array.from({ length: 15 }, (_, i) => typed(`${APP}/pull/${i + 1}`, i)).join('');
      const mentions = Array.from({ length: 10 }, (_, i) => said(`${API}/pull/${i + 1}`, 100 + i)).join('');
      await writeFile(main, prompts + mentions);
      const kept = (await links()) ?? [];
      expect(kept).toHaveLength(PR_LINKS_MAX);
      expect(kept.slice(0, 5).map((l) => [l.kind, l.number])).toEqual([10, 9, 8, 7, 6].map((n) => ['mentioned', n]));
      expect(kept.slice(5).map((l) => [l.kind, l.number])).toEqual(Array.from({ length: 15 }, (_, i) => ['prompted', 15 - i]));
      await appendFile(main, Array.from({ length: 10 }, (_, i) => typed(`${APP}/pull/${100 + i}`, 200 + i)).join(''));
      const strong = (await links()) ?? [];
      expect(strong.map((l) => l.number)).toEqual([...Array.from({ length: 10 }, (_, i) => 109 - i), ...Array.from({ length: 10 }, (_, i) => 15 - i)]);
    });

    it('has no prLinks for a transcript that can’t be read, tries again later, and keeps none in memory meanwhile', async () => {
      await writeFile(main, ran('gh pr create --fill', ghCreated(12), 1));
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
      expect(await links(s)).toBeUndefined();
      refuse = false;
      expect(await links(s)).toBeUndefined();
      clock += 30_000;
      expect(await links(s)).toEqual([{ kind: 'opened', repo: 'example/demo-app', number: 12, lastAt: time(2) }]);
      await rm(main);
      expect(await links(s)).toBeUndefined();
    });

    it('parses only lines that could link: tool calls, results it waits on, and main-transcript lines naming a PR', async () => {
      const read = use('Read', { file_path: path.join(repo('app'), 'NOTES.md') }, 1);
      const create = use('Bash', { command: 'gh pr create --fill' }, 3);
      await mkdir(subagents(), { recursive: true });
      await writeFile(path.join(subagents(), 'agent-a1.jsonl'), said(`${APP}/pull/9`, 1, { isSidechain: true }));
      await writeFile(main, read.line + result(read.id, `${APP}/pull/1`, 2) + typed('a made-up prompt', 2) + said('a made-up reply', 2) + create.line + result(create.id, ghCreated(12), 4));
      const parse = vi.spyOn(JSON, 'parse');
      try {
        expect(await links()).toEqual([{ kind: 'opened', repo: 'example/demo-app', number: 12, lastAt: time(4) }]);
        const parsed = parse.mock.calls.map(([text]) => String(text));
        expect(parsed.filter((text) => text.includes(read.id) && text.includes('"tool_result"'))).toHaveLength(0);
        expect(parsed.filter((text) => text.includes('made-up prompt') || text.includes('made-up reply') || text.includes('/pull/9'))).toHaveLength(0);
        expect(parsed.filter((text) => text.includes(create.id))).toHaveLength(2);
      } finally {
        parse.mockRestore();
      }
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
