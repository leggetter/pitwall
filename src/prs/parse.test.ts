// Reading the search's answer (parse.ts), with made-up PRs only (src/test/prs.ts).
import { describe, expect, it } from 'vitest';
import { PR_FAILING_CHECKS_MAX, PR_TITLE_MAX, prNeedsAttention, type PullRequestSummary } from '../shared/protocol.js';
import { checkRun, prNode, rollup, searchPage, statusContext } from '../test/prs.js';
import { byUpdatedNewestFirst, cleanText, isPullRequestUrl, parsePullRequest, parseSearchPage } from './parse.js';

const parse = (overrides: Record<string, unknown> = {}) => parsePullRequest(prNode(overrides));

describe('parsePullRequest', () => {
  it('maps every field as the contract says', () => {
    expect(
      parse({
        repo: 'Example/Demo-App',
        number: 42,
        isDraft: true,
        headRefName: 'feature/Demo',
        reviewDecision: 'APPROVED',
        checks: rollup('SUCCESS', [checkRun('build', 'SUCCESS')]),
      }),
    ).toEqual({
      url: 'https://github.com/Example/Demo-App/pull/42',
      repo: 'example/demo-app',
      repoLabel: 'Example/Demo-App',
      number: 42,
      title: 'Add a demo feature',
      draft: true,
      createdAt: '2026-10-01T09:00:00Z',
      updatedAt: '2026-10-20T09:00:00Z',
      head: { repo: 'example/demo-app', branch: 'feature/Demo' },
      checks: 'passing',
      review: 'approved',
      mergeable: 'clean',
    } satisfies PullRequestSummary);
  });

  it('maps the rollup: SUCCESS passing, FAILURE and ERROR failing, PENDING and EXPECTED pending, none without one', () => {
    expect(parse({ checks: rollup('SUCCESS') })?.checks).toBe('passing');
    expect(parse({ checks: rollup('FAILURE') })?.checks).toBe('failing');
    expect(parse({ checks: rollup('ERROR') })?.checks).toBe('failing');
    expect(parse({ checks: rollup('PENDING') })?.checks).toBe('pending');
    expect(parse({ checks: rollup('EXPECTED') })?.checks).toBe('pending');
    expect(parse()?.checks).toBe('none');
    expect(parse({ commits: { nodes: [] } })?.checks).toBe('none');
    expect(parse({ commits: null })?.checks).toBe('none');
    // A state pitwall doesn't know says nothing, rather than dropping the PR.
    expect(parse({ checks: rollup('SOMETHING_NEW') })?.checks).toBe('none');
  });

  it('names the failing checks: check runs by conclusion, statuses by state, deduplicated, in order', () => {
    const pr = parse({
      checks: rollup('FAILURE', [
        checkRun('build', 'SUCCESS'),
        checkRun('lint', 'FAILURE'),
        checkRun('e2e', 'TIMED_OUT'),
        checkRun('deploy', 'CANCELLED'),
        checkRun('lint', 'FAILURE'),
        checkRun('still running', null, 'IN_PROGRESS'),
        checkRun('skipped', 'SKIPPED'),
        checkRun('neutral', 'NEUTRAL'),
        statusContext('ci/legacy', 'ERROR'),
        statusContext('ci/ok', 'SUCCESS'),
        statusContext('ci/waiting', 'PENDING'),
      ]),
    });
    expect(pr).toMatchObject({ checks: 'failing', failingChecks: ['lint', 'e2e', 'deploy', 'ci/legacy'] });
    expect(pr?.failingCount).toBeUndefined();
  });

  it('counts ACTION_REQUIRED and STARTUP_FAILURE as failing, and a status with state FAILURE', () => {
    const pr = parse({
      checks: rollup('FAILURE', [checkRun('needs approval', 'ACTION_REQUIRED'), checkRun('broken workflow', 'STARTUP_FAILURE'), statusContext('ci/old', 'FAILURE')]),
    });
    expect(pr?.failingChecks).toEqual(['needs approval', 'broken workflow', 'ci/old']);
  });

  it(`keeps at most ${PR_FAILING_CHECKS_MAX} names, and failingCount says how many failed in all`, () => {
    const contexts = Array.from({ length: 8 }, (_, i) => checkRun(`job ${i + 1}`, 'FAILURE'));
    const pr = parse({ checks: rollup('FAILURE', contexts) });
    expect(pr?.failingChecks).toEqual(['job 1', 'job 2', 'job 3', 'job 4', 'job 5']);
    expect(pr?.failingCount).toBe(8);
    // Exactly the limit: no count, since every one is listed.
    const exact = parse({ checks: rollup('FAILURE', contexts.slice(0, PR_FAILING_CHECKS_MAX)) });
    expect(exact?.failingChecks).toHaveLength(PR_FAILING_CHECKS_MAX);
    expect(exact?.failingCount).toBeUndefined();
  });

  it('lists failing checks only when the rollup is failing, and none when no name can be read', () => {
    expect(parse({ checks: rollup('PENDING', [checkRun('lint', 'FAILURE')]) })).not.toHaveProperty('failingChecks');
    const unnamed = parse({ checks: rollup('FAILURE', [checkRun(42, 'FAILURE'), checkRun('\u0007‮', 'FAILURE'), { __typename: 'Unknown', name: 'x', conclusion: 'FAILURE' }, 'junk', null]) });
    expect(unnamed?.checks).toBe('failing');
    expect(unnamed).not.toHaveProperty('failingChecks');
    expect(unnamed).not.toHaveProperty('failingCount');
    expect(parse({ checks: { state: 'FAILURE', contexts: null } })).toMatchObject({ checks: 'failing' });
  });

  it('cleans failing checks’ names as titles are cleaned, and dedupes what they clean to', () => {
    const pr = parse({ checks: rollup('FAILURE', [checkRun('lint‮', 'FAILURE'), checkRun('li\u0000nt', 'FAILURE'), checkRun('\u001b[31mtest\u001b[0m', 'FAILURE')]) });
    expect(pr?.failingChecks).toEqual(['lint', 'test']);
  });

  it('maps reviewDecision, leaving it out for none or a value pitwall does not know', () => {
    expect(parse({ reviewDecision: 'APPROVED' })?.review).toBe('approved');
    expect(parse({ reviewDecision: 'CHANGES_REQUESTED' })?.review).toBe('changes-requested');
    expect(parse({ reviewDecision: 'REVIEW_REQUIRED' })?.review).toBe('review-required');
    expect(parse({ reviewDecision: null })).not.toHaveProperty('review');
    expect(parse({ reviewDecision: 'SOMETHING_NEW' })).not.toHaveProperty('review');
  });

  it('maps mergeable, with anything else as unknown', () => {
    expect(parse({ mergeable: 'MERGEABLE' })?.mergeable).toBe('clean');
    expect(parse({ mergeable: 'CONFLICTING' })?.mergeable).toBe('conflicts');
    expect(parse({ mergeable: 'UNKNOWN' })?.mergeable).toBe('unknown');
    expect(parse({ mergeable: null })?.mergeable).toBe('unknown');
    expect(parse({ mergeable: 'SOMETHING_NEW' })?.mergeable).toBe('unknown');
  });

  it('feeds prNeedsAttention: failing checks, conflicts or changes requested, drafts included', () => {
    expect(prNeedsAttention(parse({ checks: rollup('FAILURE') })!)).toBe(true);
    expect(prNeedsAttention(parse({ mergeable: 'CONFLICTING' })!)).toBe(true);
    expect(prNeedsAttention(parse({ reviewDecision: 'CHANGES_REQUESTED', isDraft: true })!)).toBe(true);
    expect(prNeedsAttention(parse({ checks: rollup('PENDING'), mergeable: 'UNKNOWN', reviewDecision: 'REVIEW_REQUIRED' })!)).toBe(false);
  });

  it("gives a fork's head as the fork's repo, in lowercase, and leaves head out when the head repo is gone", () => {
    expect(parse({ headRepository: { nameWithOwner: 'Someone-Else/demo-app' }, headRefName: 'fix-typo' })?.head).toEqual({
      repo: 'someone-else/demo-app',
      branch: 'fix-typo',
    });
    expect(parse({ headRepository: null })).not.toHaveProperty('head');
  });

  it('leaves head out for a branch it can’t compare or show as it is, and keeps the PR', () => {
    for (const headRefName of ['', 42, null, 'a'.repeat(256), 'fix\u0007bell', 'fix-‮gnp', 'line\nbreak']) {
      const pr = parse({ headRefName });
      expect(pr, String(headRefName)).toBeDefined();
      expect(pr, String(headRefName)).not.toHaveProperty('head');
    }
    expect(parse({ headRepository: { nameWithOwner: 'not a repo' } })).not.toHaveProperty('head');
    expect(parse({ headRefName: 'a'.repeat(255) })?.head?.branch).toHaveLength(255);
  });

  it('drops a node that is malformed or not a PR', () => {
    const malformed: Record<string, unknown>[] = [
      { number: 0 },
      { number: -1 },
      { number: 1.5 },
      { number: '1' },
      { title: null },
      { title: 42 },
      { isDraft: 'false' },
      { isDraft: null },
      { createdAt: 'yesterday' },
      { createdAt: null },
      { updatedAt: '2026-10-20' },
      { updatedAt: '2026-13-45T99:99:99Z' },
      { repository: null },
      { repository: { nameWithOwner: 'demo-app' } },
      { repository: { nameWithOwner: 'example/demo app' } },
      { repository: { nameWithOwner: 'example/..' } },
      { url: null },
    ];
    for (const overrides of malformed) expect(parse(overrides), JSON.stringify(overrides)).toBeUndefined();
    for (const node of [null, 'pr', 42, [], {}]) expect(parsePullRequest(node), JSON.stringify(node)).toBeUndefined();
  });
});

describe('the URL rule', () => {
  it('keeps exactly https://github.com/<owner>/<name>/pull/<number> for its own repo and number', () => {
    expect(isPullRequestUrl('https://github.com/example/demo-app/pull/7', 'example/demo-app', 7)).toBe(true);
    // GitHub's names don't depend on case.
    expect(isPullRequestUrl('https://github.com/Example/Demo-App/pull/7', 'example/demo-app', 7)).toBe(true);
    expect(isPullRequestUrl('https://github.com/example_corp/demo.app/pull/7', 'example_corp/demo.app', 7)).toBe(true);
  });

  it('drops a PR whose URL is anything else', () => {
    const repo = 'example/demo-app';
    for (const url of [
      'https://github.com/example/demo-app/pull/8',
      'https://github.com/example/other-app/pull/7',
      'https://github.com/someone/demo-app/pull/7',
      'http://github.com/example/demo-app/pull/7',
      'https://github.com.evil.example/example/demo-app/pull/7',
      'https://evil.example/example/demo-app/pull/7',
      'https://github.com/example/demo-app/pull/7/',
      'https://github.com/example/demo-app/pull/7#discussion',
      'https://github.com/example/demo-app/pull/7?x=1',
      'https://github.com/example/demo-app/pull/07',
      'https://github.com/example/demo-app/pulls/7',
      'https://github.com/example/demo-app/issues/7',
      'https://github.com/example/demo-app/pull/7/files',
      'https://github.com//example/demo-app/pull/7',
      'https://github.com/example/../demo-app/pull/7',
      'https://user@github.com/example/demo-app/pull/7',
      'https://GITHUB.com/example/demo-app/pull/7',
      'https://github.com:443/example/demo-app/pull/7',
      ' https://github.com/example/demo-app/pull/7',
      'https://github.com/example/demo-app/pull/7\n',
      'javascript:alert(1)//https://github.com/example/demo-app/pull/7',
    ]) {
      expect(isPullRequestUrl(url, repo, 7), url).toBe(false);
      expect(parse({ repo: 'example/demo-app', number: 7, url }), url).toBeUndefined();
    }
  });

  it("drops a PR whose URL names another repo than its own repository field, so the link can't point elsewhere", () => {
    expect(parse({ repository: { nameWithOwner: 'example/demo-app' }, url: 'https://github.com/attacker/demo-app/pull/1' })).toBeUndefined();
    expect(isPullRequestUrl('https://github.com/./demo/pull/1', './demo', 1)).toBe(false);
    expect(isPullRequestUrl('https://github.com/example/../pull/1', 'example/..', 1)).toBe(false);
  });
});

describe('text cleaning', () => {
  it('removes C0, DEL, C1 and the bidi controls from a title, and terminal escapes', () => {
    expect(parse({ title: 'Fix\u0000 the\u0007 bug\u007f\u0085\u009b' })?.title).toBe('Fix the bug');
    expect(parse({ title: 'evil‮ txt.exe‬' })?.title).toBe('evil txt.exe');
    for (const bidi of ['؜', '‎', '‏', '‪', '‫', '‬', '‭', '‮', '⁦', '⁧', '⁨', '⁩']) {
      expect(cleanText(`a${bidi}b`), bidi.codePointAt(0)!.toString(16)).toBe('ab');
    }
    expect(cleanText('\u001b[31mred\u001b[0m \u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007')).toBe('red link');
  });

  it('keeps a title on one line, with its whitespace collapsed, and other Unicode as it is', () => {
    expect(cleanText('  Line one\nline two\r\n\ttabbed  ')).toBe('Line one line two tabbed');
    expect(cleanText('Añadir soporte para 日本語 🚀')).toBe('Añadir soporte para 日本語 🚀');
    // Markdown stays as text: the web UI never renders it.
    expect(cleanText('**bold** <img src=x onerror=alert(1)>')).toBe('**bold** <img src=x onerror=alert(1)>');
  });

  it(`caps a title at ${PR_TITLE_MAX} characters, without splitting a surrogate pair`, () => {
    const long = parse({ title: 'x'.repeat(1000) })?.title ?? '';
    expect(long.length).toBeLessThanOrEqual(PR_TITLE_MAX);
    expect(long.endsWith('…')).toBe(true);
    const emoji = cleanText('🚀'.repeat(400));
    expect(emoji.length).toBeLessThanOrEqual(PR_TITLE_MAX);
    expect(emoji).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(cleanText('x'.repeat(PR_TITLE_MAX))).toHaveLength(PR_TITLE_MAX);
  });
});

describe('parseSearchPage', () => {
  it('reads the nodes, the total and the page info, dropping malformed nodes', () => {
    const page = parseSearchPage(searchPage([prNode({ number: 1 }), { junk: true }, {}, prNode({ number: 2, url: 'https://evil.example/' })], {
      total: 150,
      hasNextPage: true,
      endCursor: 'Y3Vyc29yOjEwMA==',
    }));
    expect(page?.prs.map((pr) => pr.number)).toEqual([1]);
    expect(page).toMatchObject({ total: 150, hasNextPage: true, endCursor: 'Y3Vyc29yOjEwMA==' });
  });

  it('reads a last page: no next page, and no cursor', () => {
    const page = parseSearchPage(searchPage([prNode()]));
    expect(page).toMatchObject({ total: 1, hasNextPage: false });
    expect(page).not.toHaveProperty('endCursor');
  });

  it('is undefined for an answer that is not a search page', () => {
    for (const stdout of ['', 'not json', 'null', '[]', '{}', '{"data":null}', '{"data":{"search":null}}', '{"data":{"search":{"nodes":{}}}}', '{"errors":[{"message":"x"}]}']) {
      expect(parseSearchPage(stdout), stdout).toBeUndefined();
    }
  });

  it('ignores a total or page info of the wrong shape', () => {
    const page = parseSearchPage(JSON.stringify({ data: { search: { issueCount: 'many', pageInfo: { hasNextPage: 'yes', endCursor: 42 }, nodes: [] } } }));
    expect(page).toEqual({ prs: [], hasNextPage: false });
  });
});

describe('byUpdatedNewestFirst', () => {
  it('sorts newest updatedAt first, and the same time by URL', () => {
    const a = parse({ number: 1, updatedAt: '2026-10-01T00:00:00Z' })!;
    const b = parse({ number: 2, updatedAt: '2026-10-03T00:00:00Z' })!;
    const c = parse({ number: 3, updatedAt: '2026-10-02T00:00:00.500Z' })!;
    const d = parse({ number: 4, updatedAt: '2026-10-02T00:00:00.500Z' })!;
    expect([a, d, c, b].sort(byUpdatedNewestFirst).map((pr) => pr.number)).toEqual([2, 3, 4, 1]);
  });
});
