import { describe, expect, it } from 'vitest';
import { lexShell, placesOf, resolveWord, slugOf, slugsIn, stripHeredocs } from './toolCalls.js';

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
});
