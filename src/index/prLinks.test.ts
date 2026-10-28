import { describe, expect, it } from 'vitest';
import { PR_LINKS_MAX } from '../shared/protocol.js';
import { addLink, linkingCall, linkKey, newestLinks, openedByGh, openedByMcp, prUrlsIn, pruneLinks, pushedIn, toPrLink, type FoundLink } from './prLinks.js';

// Every repo, branch and URL here is made up.

const APP = 'https://github.com/example/demo-app';

describe('prUrlsIn', () => {
  it('finds a PR URL, with a tab, a trailing slash, an anchor or a query, lowercasing the repo', () => {
    const text = [
      `${APP}/pull/12`,
      `(${APP}/pull/13/files)`,
      `${APP}/pull/14/commits/abc1234.`,
      `${APP}/pull/15/checks`,
      `${APP}/pull/16/`,
      `${APP}/pull/17#issuecomment-1`,
      `${APP}/pull/18?w=1`,
      '[#19](https://github.com/Example/Demo-API/pull/19),',
      `"${APP}/pull/20"`,
    ].join(' ');
    expect(prUrlsIn(text)).toEqual([
      { repo: 'example/demo-app', number: 12 },
      { repo: 'example/demo-app', number: 13 },
      { repo: 'example/demo-app', number: 14 },
      { repo: 'example/demo-app', number: 15 },
      { repo: 'example/demo-app', number: 16 },
      { repo: 'example/demo-app', number: 17 },
      { repo: 'example/demo-app', number: 18 },
      { repo: 'example/demo-api', number: 19 },
      { repo: 'example/demo-app', number: 20 },
    ]);
  });

  it('leaves out what is not a PR URL', () => {
    const text = [
      `${APP}/pull/new/feature/one`,
      `${APP}/pull/12.diff`,
      `${APP}/pull/12/merge`,
      `${APP}/pull/0`,
      `${APP}/pull/12345678901`,
      `${APP}/issues/12`,
      'https://api.github.com/repos/example/demo-app/pulls/12',
      'http://github.com/example/demo-app/pull/12',
      'https://gist.github.com/example/demo-app/pull/12',
      `x${APP}/pull/12`,
      'https://github.com/orgs/example/pull/12',
      'https://github.com/settings/demo/pull/12',
    ].join(' ');
    expect(prUrlsIn(text)).toEqual([]);
  });

  it('is linear on a long run of near-misses', () => {
    const text = `${APP}/pull/1`.repeat(1).concat('9'.repeat(200_000), ` ${'https://github.com/'.repeat(20_000)}`);
    const started = performance.now();
    prUrlsIn(text);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('openedByGh', () => {
  it('takes the lines that are a PR URL and nothing else, as gh prints the one it created', () => {
    const output = ['Creating pull request for feature/one into main in example/demo-app', '', `${APP}/pull/12  `, `See also ${APP}/pull/9`, `remote:   ${APP}/pull/8`].join('\n');
    expect(openedByGh(output)).toEqual([{ repo: 'example/demo-app', number: 12 }]);
  });

  it('takes nothing from output with no such line', () => {
    expect(openedByGh(`12\tA made-up title\tfeature/one\tOPEN\n${APP}/pull/12/files\n`)).toEqual([]);
  });
});

describe('openedByMcp', () => {
  it("takes the first PR URL: the GitHub MCP server's url, or the REST response's html_url before its body", () => {
    expect(openedByMcp(JSON.stringify({ id: '1', url: `${APP}/pull/13` }))).toEqual([{ repo: 'example/demo-app', number: 13 }]);
    const rest = { url: 'https://api.github.com/repos/example/demo-app/pulls/14', id: 2, html_url: `${APP}/pull/14`, diff_url: `${APP}/pull/14.diff`, body: `Follows ${APP}/pull/9` };
    expect(openedByMcp(JSON.stringify(rest))).toEqual([{ repo: 'example/demo-app', number: 14 }]);
    expect(openedByMcp('failed to create pull request: a made-up error')).toEqual([]);
  });
});

describe('pushedIn', () => {
  it('takes a new branch, under a To line with an https remote, past the remote lines', () => {
    const output = [
      'remote: ',
      "remote: Create a pull request for 'feature/one' on GitHub by visiting:        ",
      `remote:      ${APP}/pull/new/feature/one        `,
      'remote: ',
      `To ${APP}.git`,
      ' * [new branch]      feature/one -> feature/one',
      "branch 'feature/one' set up to track 'origin/feature/one'.",
    ].join('\n');
    expect(pushedIn(output)).toEqual([{ repo: 'example/demo-app', branch: 'feature/one' }]);
  });

  it('takes a fast-forward and a forced update, under scp-style remotes', () => {
    expect(pushedIn('To github.com:example/demo-app.git\n   1a2b3c4..5d6e7f8  main -> main\n')).toEqual([{ repo: 'example/demo-app', branch: 'main' }]);
    expect(pushedIn('To git@github.com:Example/Demo-App.git\n + 1a2b3c4...5d6e7f8 feature/two -> feature/two (forced update)\n')).toEqual([
      { repo: 'example/demo-app', branch: 'feature/two' },
    ]);
  });

  it('takes the branch from the right-hand side, without refs/heads/, and leaves out other refs', () => {
    const output = [`To ${APP}`, ' * [new branch]      HEAD -> refs/heads/feature/three', ' * [new branch]      local -> remote-name', ' * [new reference]   HEAD -> refs/made-up/x', '   1a2b3c4..5d6e7f8  HEAD -> refs/tags/v1'].join('\n');
    expect(pushedIn(output)).toEqual([
      { repo: 'example/demo-app', branch: 'feature/three' },
      { repo: 'example/demo-app', branch: 'remote-name' },
    ]);
  });

  it('leaves out rejected, remote rejected, deleted, up-to-date and new tag lines, and Everything up-to-date', () => {
    const output = [
      `To ${APP}.git`,
      ' ! [rejected]        main -> main (fetch first)',
      ' ! [remote rejected] feature/one -> feature/one (protected branch hook declined)',
      ' - [deleted]         feature/old',
      ' = [up to date]      feature/two -> feature/two',
      ' * [new tag]         v1.0.0 -> v1.0.0',
      "error: failed to push some refs to 'https://github.com/example/demo-app.git'",
      'Everything up-to-date',
    ].join('\n');
    expect(pushedIn(output)).toEqual([]);
    expect(pushedIn('Everything up-to-date\n')).toEqual([]);
  });

  it('takes each To block with its own repo, and leaves out a remote that is not GitHub', () => {
    const output = [
      `To ${APP}.git`,
      '   1a2b3c4..5d6e7f8  main -> main',
      'To gitlab.com:example/demo-app.git',
      ' * [new branch]      feature/elsewhere -> feature/elsewhere',
      'To https://github.com/example/demo-api.git',
      ' * [new branch]      feature/one -> feature/one',
    ].join('\n');
    expect(pushedIn(output)).toEqual([
      { repo: 'example/demo-app', branch: 'main' },
      { repo: 'example/demo-api', branch: 'feature/one' },
    ]);
  });

  it('needs a To line first, and reads no line longer than it has to', () => {
    expect(pushedIn(' * [new branch]      feature/one -> feature/one\n')).toEqual([]);
    expect(pushedIn(`To ${APP}\n * [new branch]      ${'x'.repeat(2000)} -> feature/one\n`)).toEqual([]);
  });
});

describe('linkingCall', () => {
  it('waits on gh pr create, git push and a GitHub MCP create_pull_request tool', () => {
    expect(linkingCall('Bash', { command: 'gh pr create --fill' })).toEqual({ opens: 'gh' });
    expect(linkingCall('Bash', { command: 'git -C ~/made-up push -u origin feature/one' })).toEqual({ pushes: true });
    expect(linkingCall('Bash', { command: 'git push -u origin HEAD && gh pr create --title t --body b' })).toEqual({ opens: 'gh', pushes: true });
    expect(linkingCall('mcp__github__create_pull_request', { owner: 'example', repo: 'demo-app' })).toEqual({ opens: 'mcp' });
  });

  it('waits on nothing else', () => {
    expect(linkingCall('Bash', { command: 'gh pr list' })).toBeUndefined();
    expect(linkingCall('Bash', { command: 'git push --dry-run' })).toBeUndefined();
    expect(linkingCall('Bash', { command: 'git stash push -m wip' })).toBeUndefined();
    expect(linkingCall('Bash', { command: 'git commit -m "then git push and gh pr create"' })).toBeUndefined();
    expect(linkingCall('Bash', { command: "cat <<'EOF' > notes.md\ngit push\ngh pr create\nEOF" })).toBeUndefined();
    expect(linkingCall('Monitor', { command: 'git push' })).toBeUndefined();
    expect(linkingCall('mcp__github__create_pull_request_review', {})).toBeUndefined();
    expect(linkingCall('Bash', null)).toBeUndefined();
  });
});

describe('newestLinks', () => {
  const link = (kind: FoundLink['kind'], number: number, at: number): FoundLink => (kind === 'pushed' ? { kind, repo: 'example/demo-app', branch: `b${number}`, at } : { kind, repo: 'example/demo-app', number, at });

  it('orders newest first, ties by kind, then repo and number', () => {
    const links = [link('mentioned', 1, 5), link('prompted', 2, 5), link('opened', 3, 5), link('pushed', 4, 9), link('opened', 1, 5)];
    expect(newestLinks(links).map((l) => [l.kind, l.number ?? l.branch])).toEqual([
      ['pushed', 'b4'],
      ['opened', 1],
      ['opened', 3],
      ['prompted', 2],
      ['mentioned', 1],
    ]);
  });

  it('over the cap, drops the oldest mentioned links first, then the oldest of the rest', () => {
    const strong = Array.from({ length: 15 }, (_, i) => link('prompted', i + 1, 100 + i));
    const mentioned = Array.from({ length: 10 }, (_, i) => link('mentioned', 100 + i, 1000 + i));
    const kept = newestLinks([...strong, ...mentioned]);
    expect(kept).toHaveLength(PR_LINKS_MAX);
    expect(kept.filter((l) => l.kind === 'prompted')).toHaveLength(15);
    // The newest 5 mentioned, which are newer than every strong one, so first.
    expect(kept.slice(0, 5).map((l) => l.number)).toEqual([109, 108, 107, 106, 105]);
    const many = Array.from({ length: 25 }, (_, i) => link('opened', i + 1, i + 1));
    expect(newestLinks([...many, link('mentioned', 99, 999)]).map((l) => l.number)).toEqual(Array.from({ length: 20 }, (_, i) => 25 - i));
  });

  it('keeps what merging whole files would, after pruning each', () => {
    const files = [0, 1, 2].map((f) => {
      const links = new Map<string, FoundLink>();
      for (let i = 0; i < 200; i++) addLink(links, link(i % 3 === 0 ? 'mentioned' : i % 3 === 1 ? 'opened' : 'pushed', (i * 7 + f * 13) % 90, (i * 31 + f * 17) % 500 + 1));
      return links;
    });
    const whole = new Map<string, FoundLink>();
    for (const file of files) for (const found of file.values()) addLink(whole, found);
    const pruned = new Map<string, FoundLink>();
    for (const file of files) {
      pruneLinks(file);
      expect(file.size).toBeLessThanOrEqual(2 * PR_LINKS_MAX);
      for (const found of file.values()) addLink(pruned, found);
    }
    expect(newestLinks(pruned.values())).toEqual(newestLinks(whole.values()));
  });
});

describe('the links', () => {
  it('keeps the newest of each kind and PR, or pushed branch', () => {
    const links = new Map<string, FoundLink>();
    addLink(links, { kind: 'mentioned', repo: 'example/demo-app', number: 12, at: 5 });
    addLink(links, { kind: 'mentioned', repo: 'example/demo-app', number: 12, at: 9 });
    addLink(links, { kind: 'mentioned', repo: 'example/demo-app', number: 12, at: 7 });
    addLink(links, { kind: 'prompted', repo: 'example/demo-app', number: 12, at: 1 });
    addLink(links, { kind: 'pushed', repo: 'example/demo-app', branch: 'main', at: 1 });
    addLink(links, { kind: 'pushed', repo: 'example/demo-app', branch: 'feature/one', at: 1 });
    expect([...links.values()].map((l) => [l.kind, l.at])).toEqual([
      ['mentioned', 9],
      ['prompted', 1],
      ['pushed', 1],
      ['pushed', 1],
    ]);
    expect(linkKey({ kind: 'opened', repo: 'example/demo-app', number: 12 })).not.toBe(linkKey({ kind: 'mentioned', repo: 'example/demo-app', number: 12 }));
  });

  it('become PrLinks with an ISO time, a number or a branch, never both', () => {
    const at = Date.parse('2026-10-16T12:00:00.000Z');
    expect(toPrLink({ kind: 'opened', repo: 'example/demo-app', number: 12, at })).toEqual({ kind: 'opened', repo: 'example/demo-app', number: 12, lastAt: '2026-10-16T12:00:00.000Z' });
    expect(toPrLink({ kind: 'pushed', repo: 'example/demo-app', branch: 'main', at })).toEqual({ kind: 'pushed', repo: 'example/demo-app', branch: 'main', lastAt: '2026-10-16T12:00:00.000Z' });
  });
});
