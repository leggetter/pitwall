import { describe, expect, it } from 'vitest';
import { lexShell, MAX_PATH_WORD, MAX_SHELL_COMMAND, placesOf, prCommandsOf, resolveWord, slugOf, slugsIn, stripHeredocs } from './toolCalls.js';

// Made-up paths and repos only.
const HOME = '/Users/example';
const CODE = '/Users/example/code';
const CWD = `${CODE}/app`;

const of = (name: string, input: unknown, cwd: unknown = CWD) => placesOf(name, input, cwd, HOME);
const bash = (command: string, cwd: unknown = CWD) => of('Bash', { command }, cwd);

describe('placesOf: the file signal', () => {
  it("takes the directory of a Read, Edit, MultiEdit, Write, NotebookEdit and LSP call's file, and the entry's cwd", () => {
    for (const [name, key] of [['Read', 'file_path'], ['Edit', 'file_path'], ['MultiEdit', 'file_path'], ['Write', 'file_path'], ['NotebookEdit', 'notebook_path'], ['LSP', 'filePath']] as const) {
      expect(of(name, { [key]: `${CODE}/api/src/server.ts` }).paths).toEqual([CWD, `${CODE}/api/src`]);
    }
  });

  it('takes Grep and Glob paths as they are, since they can be a directory, and a Glob pattern that is absolute', () => {
    expect(of('Grep', { pattern: 'retry', path: `${CODE}/api` }).paths).toEqual([CWD, `${CODE}/api`]);
    expect(of('Glob', { pattern: `${CODE}/docs/**/*.md` }).paths).toEqual([CWD, `${CODE}/docs`]);
    // No path: it searched the cwd, which is there already.
    expect(of('Grep', { pattern: 'retry' }).paths).toEqual([CWD]);
  });

  it('resolves a relative path against the cwd, and expands ~', () => {
    expect(of('Read', { file_path: '../api/README.md' }).paths).toEqual([CWD, `${CODE}/api`]);
    expect(of('Read', { file_path: '~/code/docs/a.md' }).paths).toEqual([CWD, `${CODE}/docs`]);
  });

  it('marks an Edit, MultiEdit, Write or NotebookEdit as a change, and a Read, Grep or LSP as not', () => {
    for (const name of ['Edit', 'MultiEdit', 'Write']) expect(of(name, { file_path: `${CODE}/api/a.ts` }).changedPaths).toEqual([`${CODE}/api`]);
    expect(of('NotebookEdit', { notebook_path: `${CODE}/api/n.ipynb` }).changedPaths).toEqual([`${CODE}/api`]);
    for (const name of ['Read', 'LSP']) expect(of(name, { file_path: `${CODE}/api/a.ts` }).changedPaths).toEqual([]);
    expect(of('Grep', { path: `${CODE}/api` }).changedPaths).toEqual([]);
  });
});

describe('placesOf: the cwd signal', () => {
  it("takes the entry's cwd for every call, and nothing when it isn't an absolute path", () => {
    expect(of('TodoWrite', { todos: [] }).paths).toEqual([CWD]);
    expect(of('TodoWrite', {}, 'relative/dir').paths).toEqual([]);
    expect(of('TodoWrite', {}, null).paths).toEqual([]);
  });
});

describe('placesOf: the cd signal', () => {
  it('takes cd, pushd and git -C targets, relative ones against the shell as it moves', () => {
    expect(bash(`cd ${CODE}/api && npm test`).paths).toEqual([CWD, `${CODE}/api`]);
    expect(bash('pushd ../docs; ls').paths).toEqual([CWD, `${CODE}/docs`]);
    expect(bash(`git -C ${CODE}/web status`).paths).toEqual([CWD, `${CODE}/web`]);
    expect(bash('cd ../api && cd ../web && git -C ../docs log').paths).toEqual([CWD, `${CODE}/api`, `${CODE}/web`, `${CODE}/docs`]);
  });

  it('takes cd with no argument as home, and loses track after cd - or a variable', () => {
    expect(bash('cd && ls').paths).toEqual([CWD, HOME]);
    expect(bash('cd - && cd docs').paths).toEqual([CWD]);
    expect(bash('cd "$WORK" && cd docs').paths).toEqual([CWD]);
  });

  it('leaves out other absolute and relative paths in commands', () => {
    expect(bash(`cat ${CODE}/api/README.md ../web/package.json && ls src/`).paths).toEqual([CWD]);
    expect(bash(`npm --prefix ${CODE}/docs test`).paths).toEqual([CWD]);
  });

  it('reads Monitor commands too, and no other tool’s', () => {
    expect(of('Monitor', { command: `cd ${CODE}/api && npm run watch` }).paths).toEqual([CWD, `${CODE}/api`]);
    expect(of('Task', { command: `cd ${CODE}/api` }).paths).toEqual([CWD]);
  });

  it('ignores here-document bodies, comments and quoted text', () => {
    expect(bash(`cat > notes.txt <<'EOF'\ncd ${CODE}/api\ngit commit -m x\nEOF\necho done`).paths).toEqual([CWD]);
    expect(bash(`# cd ${CODE}/api\necho "cd ${CODE}/web"`).paths).toEqual([CWD]);
  });
});

describe('placesOf: changes in commands', () => {
  it('marks git commit and git push as changing where they ran: the -C target, or the shell after any cd', () => {
    expect(bash('git commit -m "a message"').changedPaths).toEqual([CWD]);
    expect(bash('git push origin HEAD').changedPaths).toEqual([CWD]);
    expect(bash(`git -C ${CODE}/api commit -am fix`).changedPaths).toEqual([`${CODE}/api`]);
    expect(bash('git -c user.name=x commit -m y').changedPaths).toEqual([CWD]);
    // The commit after the second cd is in web, not api.
    expect(bash(`cd ${CODE}/api && git worktree prune && cd ${CODE}/web && git commit -m fix`).changedPaths).toEqual([`${CODE}/web`]);
  });

  it("doesn't take git's other subcommands, or a commit message that names one, as a change", () => {
    expect(bash('git status && git log --oneline && git diff').changedPaths).toEqual([]);
    expect(bash('git log --grep "git push"').changedPaths).toEqual([]);
    expect(bash('echo git commit').changedPaths).toEqual([]);
  });

  it('marks gh pr create and gh pr merge as changing the repo they name, or where they ran', () => {
    expect(bash('gh pr create --repo example-org/api --title "Fix" --body "b"')).toMatchObject({ slugs: ['example-org/api'], changedSlugs: ['example-org/api'], changedPaths: [] });
    expect(bash('gh pr merge 12 --squash')).toMatchObject({ changedPaths: [CWD], changedSlugs: [] });
    expect(bash('gh pr view 12 --repo example-org/api')).toMatchObject({ slugs: ['example-org/api'], changedSlugs: [], changedPaths: [] });
  });
});

describe('placesOf: the gh signal', () => {
  it('takes --repo, -R and --repo=, gh api repos/ paths, and github.com URLs in gh commands', () => {
    expect(bash('gh run list -R Example-Org/API').slugs).toEqual(['example-org/api']);
    expect(bash('gh issue list --repo=example-org/web').slugs).toEqual(['example-org/web']);
    expect(bash('gh api repos/example-org/docs/pulls --jq .').slugs).toEqual(['example-org/docs']);
    expect(bash('gh pr checks https://github.com/example-org/api/pull/7').slugs).toEqual(['example-org/api']);
  });

  it('takes git clone and git remote URLs, WebFetch URLs and the GitHub MCP tools’ owner and repo', () => {
    expect(bash('git clone git@github.com:example-org/sdk.git').slugs).toEqual(['example-org/sdk']);
    expect(bash('git remote add upstream https://github.com/example-org/sdk.git').slugs).toEqual(['example-org/sdk']);
    expect(of('WebFetch', { url: 'https://github.com/example-org/web/blob/main/README.md' }).slugs).toEqual(['example-org/web']);
    expect(of('mcp__github__get_pull_request', { owner: 'example-org', repo: 'api', pull_number: 3 }).slugs).toEqual(['example-org/api']);
  });

  it('leaves out GitHub paths that are not repos, and URLs outside gh and git', () => {
    expect(bash('gh api orgs/example-org/repos').slugs).toEqual([]);
    expect(slugsIn('https://github.com/settings/tokens and https://github.com/orgs/example-org')).toEqual([]);
    expect(bash('curl https://github.com/example-org/api').slugs).toEqual([]);
  });
});

describe('the shell helpers', () => {
  it('splits commands on operators, keeping quoted words whole', () => {
    expect(lexShell(`cd "a b" && echo 'c;d' | wc -l; ls $(pwd)`)).toEqual([['cd', 'a b'], ['echo', 'c;d'], ['wc', '-l'], ['ls'], ['pwd']]);
  });

  it('drops here-document bodies up to their marker', () => {
    expect(stripHeredocs('cat <<EOF\nbody\nEOF\nnext')).toBe('cat <<EOF\nnext');
  });

  it('resolves words to absolute paths, or undefined', () => {
    expect(resolveWord('src/a.ts:12', CWD, HOME)).toBe(`${CWD}/src/a.ts`);
    expect(resolveWord('$HOME/code', CWD, HOME)).toBe(CODE);
    expect(resolveWord('$OTHER/code', CWD, HOME)).toBeUndefined();
    expect(resolveWord('docs', undefined, HOME)).toBeUndefined();
    expect(resolveWord('/a/b/*.ts', undefined, HOME)).toBe('/a/b');
  });

  it('reads owner/name and github.com URLs as slugs', () => {
    expect(slugOf('Example-Org/Repo.git')).toBe('example-org/repo');
    expect(slugOf('https://github.com/example-org/repo')).toBe('example-org/repo');
    expect(slugOf('not a repo')).toBeUndefined();
  });

  it('cuts trailing punctuation, and keeps it inside a word', () => {
    expect(resolveWord('/a/b.', CWD, HOME)).toBe('/a/b');
    expect(resolveWord('/a/b),;:.', CWD, HOME)).toBe('/a/b');
    expect(resolveWord('/a/....x', CWD, HOME)).toBe('/a/....x');
    expect(resolveWord('...', CWD, HOME)).toBeUndefined();
  });

  it('skips a word longer than any path the system will open', () => {
    const longest = `/${'a'.repeat(MAX_PATH_WORD - 1)}`;
    expect(resolveWord(longest, CWD, HOME)).toBe(longest);
    expect(resolveWord(`${longest}a`, CWD, HOME)).toBeUndefined();
  });

  it('drops several here-documents, opened on one line or one after another', () => {
    expect(bash(`cat <<A <<'B'\ncd ${CODE}/web\nA\ncd ${CODE}/docs\nB\ncd ../api`).paths).toEqual([CWD, `${CODE}/api`]);
    expect(bash(`cat <<A\ncd ${CODE}/web\nA\ncat <<B\ncd ${CODE}/docs\nB\ncd ../api`).paths).toEqual([CWD, `${CODE}/api`]);
  });
});

// W48 F1 and F9: a session writes these, and the scanner reads them on the main thread on every
// start. Made-up input, after the reviewer's proof of concept.
//
// The timing checks are an absolute bound set far from both sides, not a ratio of two timings.
// Before the fixes, the 40,000-character inputs took 1.2 s each, 1,000 words at the limit 14.5 s,
// the here-documents 4 to 7 s at 1 MiB and 146 s at 4 MiB, and a 1 MiB run of dots would take
// about 14 minutes (quadratic from 1.2 s at 40,000). After them, each test takes from under 1 ms
// to about 60 ms, so a 1 s bound leaves a loaded CI runner a wide margin and still fails the old
// code. A scaling ratio would rest on sub-millisecond readings, where timer resolution, JIT
// warm-up and garbage collection decide the answer, so it would be the flakier check here.
describe('placesOf: bounded on long input', () => {
  const BOUND_MS = 1_000;
  const MIB = 1 << 20;
  const PUNCTUATION = ['.', ',', ';', ':', ')'];
  const timed = (fn: () => void): number => {
    const started = performance.now();
    fn();
    return performance.now() - started;
  };
  /**
   * The reviewer's three paths to resolveWord(), each one tool call, with `run` in the path. The
   * shell words are quoted, so `;` and `)`, which end a command, stay in them; for `.` the
   * reviewer's unquoted form makes the same word.
   */
  const paths = (run: string): [string, Record<string, unknown>][] => [
    ['Bash', { command: `cd '${run}x' && ls` }],
    ['Bash', { command: `git -C '${run}x' status` }],
    ['Read', { file_path: `${CODE}/${run}x/a.ts` }],
  ];

  it('reads a 40,000-character run of punctuation in a cd, a git -C or a Read path at once, and names nothing for it', () => {
    let results: unknown[] = [];
    const ms = timed(() => {
      results = PUNCTUATION.flatMap((ch) => paths(ch.repeat(40_000)).map(([name, input]) => of(name, input)));
    });
    expect(ms).toBeLessThan(BOUND_MS);
    expect(results).toHaveLength(15);
    for (const result of results) expect(result).toEqual({ paths: [CWD], changedPaths: [], slugs: [], changedSlugs: [] });
  });

  it('reads the same paths with a 1 MiB run at once', () => {
    const ms = timed(() => {
      for (const ch of PUNCTUATION) {
        for (const [name, input] of paths(ch.repeat(MIB))) expect(of(name, input).paths).toEqual([CWD]);
        expect(resolveWord(`${ch.repeat(MIB)}x`, CWD, HOME)).toBeUndefined();
      }
    });
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it('cuts the punctuation from 1,000 words at the limit in linear time', () => {
    const words = Array.from({ length: 1_000 }, (_, i) => `${(PUNCTUATION[i % 5] ?? '.').repeat(MAX_PATH_WORD - 1)}x`);
    const ms = timed(() => {
      for (const word of words) expect(resolveWord(word, CWD, HOME)).toBe(`${CWD}/${word}`);
    });
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it('strips a 1 MiB and a 4 MiB run of here-documents opened on one line in linear time', () => {
    for (const bytes of [MIB, 4 * MIB]) {
      const n = bytes / 8;
      const openers = 'cat <<A '.repeat(n);
      let stripped = '';
      const ms = timed(() => {
        stripped = stripHeredocs(`${openers}\n${'A\n'.repeat(n)}cd ../api`);
      });
      expect(ms).toBeLessThan(BOUND_MS);
      expect(stripped).toBe(`${openers}\ncd ../api`);
    }
  });

  it(`reads a Bash or Monitor command of up to ${MAX_SHELL_COMMAND / 1024} KiB, and only the cwd of a longer one`, () => {
    const ending = 'cd ../api && git commit -m x # ';
    const longest = `${ending}${'x'.repeat(MAX_SHELL_COMMAND - ending.length)}`;
    for (const name of ['Bash', 'Monitor']) {
      expect(of(name, { command: longest })).toMatchObject({ paths: [CWD, `${CODE}/api`], changedPaths: [`${CODE}/api`] });
      expect(of(name, { command: `${longest}x` })).toEqual({ paths: [CWD], changedPaths: [], slugs: [], changedSlugs: [] });
    }
  });

  it('still reads a long here-document that writes a file, under the limit', () => {
    const body = `${'x'.repeat(79)}\n`.repeat(Math.floor((MAX_SHELL_COMMAND - 1024) / 80));
    expect(bash(`cd ../api && cat > data.txt <<'EOF'\n${body}EOF\ngit commit -am data`)).toMatchObject({ paths: [CWD, `${CODE}/api`], changedPaths: [`${CODE}/api`] });
  });

  it('skips a 16 MiB command, the longest line the scanner keeps, at once', () => {
    const command = `cd ${'a'.repeat(16 * MIB)}`;
    let result: unknown;
    expect(timed(() => (result = bash(command)))).toBeLessThan(BOUND_MS);
    expect(result).toEqual({ paths: [CWD], changedPaths: [], slugs: [], changedSlugs: [] });
  });
});

describe('prCommandsOf (W94)', () => {
  it('finds git push past git’s own options, assignments and wrappers, and gh pr create', () => {
    expect(prCommandsOf('git -C ../api -c push.default=current push')).toEqual({ push: true, prCreate: false });
    expect(prCommandsOf('GIT_TRACE=0 env git --no-pager push origin HEAD')).toEqual({ push: true, prCreate: false });
    expect(prCommandsOf('cd ../api && git add -A && git commit -m "x" && git push -u origin feature/one')).toEqual({ push: true, prCreate: false });
    expect(prCommandsOf('gh pr create --repo example/demo-app --fill')).toEqual({ push: false, prCreate: true });
    expect(prCommandsOf('git push && gh pr create --fill')).toEqual({ push: true, prCreate: true });
    expect(prCommandsOf('gh pr new --title t --body b')).toEqual({ push: false, prCreate: true });
    expect(prCommandsOf('git push -uf origin feature/one')).toEqual({ push: true, prCreate: false });
    expect(prCommandsOf('git push --no-verify origin feature/one')).toEqual({ push: true, prCreate: false });
  });

  it('finds neither in a dry run, another subcommand, quoted text, a comment or a here-document', () => {
    for (const command of [
      'git push --dry-run',
      'git push -n origin main',
      'git push -nu origin feature/one',
      'git push -un origin feature/one',
      'git push -fnv origin feature/one',
      'git stash push -m wip',
      'gh pr view --json url',
      'echo "git push"',
      'ls # then git push',
      "cat <<'EOF' > plan.md\ngit push\ngh pr create\nEOF",
      'gh repo create example/demo-app',
    ]) {
      expect(prCommandsOf(command)).toEqual({ push: false, prCreate: false });
    }
  });

  it('reads no command over MAX_SHELL_COMMAND', () => {
    expect(prCommandsOf(`git push ${'x'.repeat(MAX_SHELL_COMMAND)}`)).toEqual({ push: false, prCreate: false });
  });
});
