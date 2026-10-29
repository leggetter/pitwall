// One fetch (fetch.ts), with a fake runFile: no test here runs gh. Each search is its own call
// (W101), so most tests here fetch the author search alone, as W93's single search was.
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { RunError, type RunFile, type RunOptions } from '../index/exec.js';
import { PR_RELATIONS, PRS_FETCH_TIMEOUT_MS, PRS_MAX, type PullRequestRelation } from '../shared/protocol.js';
import { checkRun, prNode, reviewRequests, rollup, searchPage, VIEWER } from '../test/prs.js';
import {
  exitError,
  FETCH_ERRORS,
  fetchPullRequests,
  fetchSearch,
  ghArgs,
  ghEnvironment,
  isWellFormedCursor,
  mergeSearches,
  PRS_MAX_PAGES,
  PRS_PAGE_MAX_BYTES,
  PRS_PAGE_SIZE,
  PRS_QUERIES,
  PRS_SEARCHES,
} from './fetch.js';
import { parsePullRequest } from './parse.js';

const authored = (options: Parameters<typeof fetchSearch>[1]) => fetchSearch('authored', options);

interface Call {
  file: string;
  args: readonly string[];
  options: RunOptions;
}

/** A runFile that answers each call with the next of `answers`: stdout, or an error to reject with. */
function fakeRunFile(answers: (string | Error)[], onCall?: (call: Call) => void): { runFile: RunFile; calls: Call[] } {
  const calls: Call[] = [];
  const runFile: RunFile = async (file, args, options) => {
    const call = { file, args, options };
    calls.push(call);
    onCall?.(call);
    const answer = answers.shift();
    if (answer === undefined) throw new Error('no more answers');
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { runFile, calls };
}

/** n made-up PRs, numbered from `from`, each updated a minute after the one before. */
function prs(n: number, from = 1): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) =>
    prNode({ number: from + i, updatedAt: new Date(Date.UTC(2026, 9, 1) + (from + i) * 60_000).toISOString().replace('.000', '') }),
  );
}

/** The value of each `-f name=value`, by name. */
function fields(args: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '-f') continue;
    const field = args[i + 1] ?? '';
    const eq = field.indexOf('=');
    result[field.slice(0, eq)] = field.slice(eq + 1);
  }
  return result;
}

/** The search a call ran, from its `-f q=` field. */
const relationOf = (args: readonly string[]): PullRequestRelation | undefined => PR_RELATIONS.find((relation) => fields(args).q === PRS_SEARCHES[relation]);

describe('fetchPullRequests: the command', () => {
  it('runs gh api graphql on github.com once per search, with its query and its search as -f string fields, never -F', async () => {
    const { runFile, calls } = fakeRunFile([searchPage([]), searchPage([]), searchPage([])]);
    await fetchPullRequests({ runFile });
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.file).toBe('gh');
      expect(call.args.slice(0, 4)).toEqual(['api', 'graphql', '--hostname', 'github.com']);
      expect(call.args).not.toContain('-F');
      expect(call.args.filter((arg) => arg.startsWith('-'))).toEqual(['--hostname', '-f', '-f']);
    }
    expect(calls.map((call) => fields(call.args))).toEqual(PR_RELATIONS.map((relation) => ({ query: PRS_QUERIES[relation], q: PRS_SEARCHES[relation] })));
  });

  it('searches open PRs in repos that aren’t archived, newest update first: yours, those that want your review, and those that mention you, neither of those yours (W101)', () => {
    expect(PRS_SEARCHES).toEqual({
      authored: 'is:pr is:open author:@me archived:false sort:updated-desc',
      'review-requested': 'is:pr is:open review-requested:@me -author:@me archived:false sort:updated-desc',
      mentioned: 'is:pr is:open mentions:@me -author:@me archived:false sort:updated-desc',
    });
  });

  it('asks for every field the contract needs, in every search, and who was asked only in the review-requested one', () => {
    for (const relation of PR_RELATIONS) {
      for (const field of [
        'url',
        'number',
        'title',
        'isDraft',
        'createdAt',
        'updatedAt',
        'headRefName',
        'headRepository { nameWithOwner }',
        'repository { nameWithOwner }',
        'reviewDecision',
        'mergeable',
        'commits(last: 1)',
        'statusCheckRollup',
        'contexts(first: 100)',
        '... on CheckRun { name status conclusion }',
        '... on StatusContext { context state }',
        'pageInfo { hasNextPage endCursor }',
        'issueCount',
        'search(query: $q, type: ISSUE, first: 25, after: $after)',
      ]) {
        expect(PRS_QUERIES[relation], `${relation}: ${field}`).toContain(field);
      }
      const reviews = relation === 'review-requested';
      for (const field of ['viewer { login }', 'reviewRequests(first: 100)', '... on User { login }', '... on Team { combinedSlug }']) {
        expect(PRS_QUERIES[relation].includes(field), `${relation}: ${field}`).toBe(reviews);
      }
    }
  });

  it('runs in the temp directory, with a timeout of PRS_FETCH_TIMEOUT_MS, a cap on stdout, and an environment that never prompts', async () => {
    const env = { PATH: '/usr/bin', HOME: '/home/demo', GH_FORCE_TTY: '1', CLICOLOR_FORCE: '1', GH_TOKEN: 'kept-for-gh' };
    const { runFile, calls } = fakeRunFile([searchPage([])]);
    await authored({ runFile, env, monotonicNow: () => 1000 });
    const options = calls[0]!.options;
    expect(options.timeoutMs).toBe(PRS_FETCH_TIMEOUT_MS);
    expect(options.maxStdoutBytes).toBe(PRS_PAGE_MAX_BYTES);
    expect(options.env).toEqual({ PATH: '/usr/bin', HOME: '/home/demo', GH_TOKEN: 'kept-for-gh', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' });
    expect(options.cwd).toBe(os.tmpdir());
  });

  it('passes the gh it was given', async () => {
    const { runFile, calls } = fakeRunFile([searchPage([])]);
    await authored({ runFile, ghBin: '/opt/demo/bin/gh' });
    expect(calls[0]?.file).toBe('/opt/demo/bin/gh');
  });

  it('builds page 2 with -f after=<cursor> only', () => {
    expect(fields(ghArgs('mentioned', 'Y3Vyc29yOjEwMA=='))).toEqual({ query: PRS_QUERIES.mentioned, q: PRS_SEARCHES.mentioned, after: 'Y3Vyc29yOjEwMA==' });
    expect(ghArgs('authored').some((arg) => arg.startsWith('after='))).toBe(false);
  });

  it('copies the environment rather than changing it', () => {
    const env = { GH_FORCE_TTY: '1' };
    ghEnvironment(env);
    expect(env).toEqual({ GH_FORCE_TTY: '1' });
  });
});

describe('fetchSearch: one search, the author one', () => {
  it('sorts the PRs by updatedAt, newest first', async () => {
    const nodes = [
      prNode({ number: 1, updatedAt: '2026-10-01T00:00:00Z' }),
      prNode({ number: 2, updatedAt: '2026-10-03T00:00:00Z' }),
      prNode({ number: 3, updatedAt: '2026-10-02T00:00:00Z' }),
    ];
    const { runFile } = fakeRunFile([searchPage(nodes)]);
    const result = await authored({ runFile });
    expect(result.ok && result.prs.map((pr) => pr.number)).toEqual([2, 3, 1]);
    expect(result).toMatchObject({ ok: true, truncated: false });
  });

  it('keeps what it can read and drops the rest', async () => {
    const { runFile } = fakeRunFile([searchPage([prNode({ number: 1 }), { not: 'a pr' }, prNode({ number: 2, url: 'https://evil.example/pull/2' })])]);
    const result = await authored({ runFile });
    expect(result.ok && result.prs.map((pr) => pr.number)).toEqual([1]);
  });

  it('fails as unreadable when GitHub returned PRs and every one was dropped, so the last good list stays', async () => {
    // As after a change in the answer's shape: nodes that are there, none of them readable.
    const changed = [{ pullRequest: { url: 'https://github.com/example/demo-app/pull/1' } }, prNode({ number: '1' }), {}];
    for (const stdout of [searchPage(changed), searchPage([], { total: 3 }), searchPage(changed, { total: 0 })]) {
      const { runFile } = fakeRunFile([stdout]);
      expect(await authored({ runFile }), stdout.slice(0, 80)).toEqual({ ok: false, reason: 'error', error: FETCH_ERRORS.unreadable });
    }
  });

  it('is an empty list, not a failure, when GitHub found none', async () => {
    const { runFile } = fakeRunFile([searchPage([], { total: 0 })]);
    expect(await authored({ runFile })).toEqual({ ok: true, prs: [], truncated: false });
  });

  it('keeps page 2’s PRs when every one on page 1 was dropped', async () => {
    const { runFile } = fakeRunFile([
      searchPage([{}, {}], { total: 3, hasNextPage: true, endCursor: 'abc' }),
      searchPage([prNode({ number: 3 })], { total: 3 }),
    ]);
    const result = await authored({ runFile });
    expect(result.ok && result.prs.map((pr) => pr.number)).toEqual([3]);
  });

  it('fetches page 2 with page 1’s cursor, and puts the two together, without duplicates', async () => {
    const page1 = searchPage(prs(100, 1), { total: 150, hasNextPage: true, endCursor: 'Y3Vyc29yOjEwMA==' });
    // A PR updated between the two pages can show up on both.
    const page2 = searchPage([...prs(50, 101), prNode({ number: 100, updatedAt: '2026-10-28T00:00:00Z' })], { total: 150 });
    const { runFile, calls } = fakeRunFile([page1, page2]);
    const result = await authored({ runFile });
    expect(calls).toHaveLength(2);
    expect(fields(calls[1]!.args).after).toBe('Y3Vyc29yOjEwMA==');
    expect(result).toMatchObject({ ok: true, truncated: false });
    if (!result.ok) return;
    expect(result.prs).toHaveLength(150);
    expect(new Set(result.prs.map((pr) => pr.url)).size).toBe(150);
    expect(result.prs[0]?.number).toBe(150);
  });

  it(`stops at ${PRS_MAX}, and says the list is truncated when GitHub has more`, async () => {
    const page1 = searchPage(prs(100, 1), { total: 230, hasNextPage: true, endCursor: 'Y3Vyc29yOjEwMA==' });
    const page2 = searchPage(prs(100, 101), { total: 230, hasNextPage: true, endCursor: 'Y3Vyc29yOjIwMA==' });
    const { runFile, calls } = fakeRunFile([page1, page2]);
    const result = await authored({ runFile });
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({ ok: true, truncated: true });
    expect(result.ok && result.prs).toHaveLength(PRS_MAX);
  });

  it('says truncated when the total is over the limit, even if page 2 says it is the last', async () => {
    const { runFile } = fakeRunFile([
      searchPage(prs(100, 1), { total: 201, hasNextPage: true, endCursor: 'abc' }),
      searchPage(prs(100, 101), { total: 201, hasNextPage: false }),
    ]);
    expect(await authored({ runFile })).toMatchObject({ ok: true, truncated: true });
  });

  it("doesn't pass on a cursor of the wrong shape: page 1 alone, truncated", async () => {
    for (const endCursor of ['@/etc/passwd', 'a b', '', 'x'.repeat(257), 'cursor\n', '-F', 'é']) {
      const { runFile, calls } = fakeRunFile([searchPage(prs(100), { total: 150, hasNextPage: true, endCursor })]);
      const result = await authored({ runFile });
      expect(calls, endCursor).toHaveLength(1);
      expect(result, endCursor).toMatchObject({ ok: true, truncated: true });
    }
    // No cursor at all, though GitHub said there's more.
    const { runFile, calls } = fakeRunFile([searchPage(prs(100), { total: 150, hasNextPage: true, endCursor: null })]);
    expect(await authored({ runFile })).toMatchObject({ ok: true, truncated: true });
    expect(calls).toHaveLength(1);
  });

  it('knows a cursor by its shape: base64, at most 256 characters, starting with a letter or digit', () => {
    for (const cursor of ['Y3Vyc29yOjEwMA==', 'Y3Vyc29yOjEwMA', 'abc-_+/=', 'x'.repeat(256)]) expect(isWellFormedCursor(cursor), cursor).toBe(true);
    for (const cursor of ['', '@file', '-F', '+abc', '=', 'a b', 'a\u0000', 'x'.repeat(257), 'a=b&c']) expect(isWellFormedCursor(cursor), cursor).toBe(false);
  });

  it('fetches a single page when GitHub says there is no next one', async () => {
    const { runFile, calls } = fakeRunFile([searchPage(prs(3), { hasNextPage: false, endCursor: 'abc' })]);
    expect(await authored({ runFile })).toMatchObject({ ok: true, truncated: false });
    expect(calls).toHaveLength(1);
  });

  it('gives page 2 only the time left of PRS_FETCH_TIMEOUT_MS, and fails when none is left', async () => {
    let clock = 0;
    const page1 = searchPage(prs(100), { total: 150, hasNextPage: true, endCursor: 'abc' });
    const { runFile, calls } = fakeRunFile([page1, searchPage(prs(50, 101))], (call) => {
      // Page 1 takes 20 s.
      if (call.args.every((arg) => !arg.startsWith('after='))) clock += 40_000;
    });
    expect(await authored({ runFile, monotonicNow: () => clock })).toMatchObject({ ok: true });
    expect(calls.map((call) => call.options.timeoutMs)).toEqual([60_000, 20_000]);

    clock = 0;
    const slow = fakeRunFile([page1, searchPage([])], () => {
      clock += 60_000;
    });
    expect(await authored({ runFile: slow.runFile, monotonicNow: () => clock })).toEqual({ ok: false, reason: 'error', error: FETCH_ERRORS.timeout });
    expect(slow.calls).toHaveLength(1);
  });

  it('times the deadline on a monotonic clock by default, so setting the system clock can’t cut it', async () => {
    const realNow = Date.now;
    let jumps = 0;
    // Each read of the wall clock is an hour on from the last.
    Date.now = () => realNow() + ++jumps * 60 * 60_000;
    try {
      const { runFile, calls } = fakeRunFile([searchPage(prs(100), { total: 150, hasNextPage: true, endCursor: 'abc' }), searchPage(prs(50, 101))]);
      expect(await authored({ runFile })).toMatchObject({ ok: true });
      expect(calls).toHaveLength(2);
      expect(calls[1]!.options.timeoutMs).toBeGreaterThan(PRS_FETCH_TIMEOUT_MS - 5000);
      expect(calls[1]!.options.timeoutMs).toBeLessThanOrEqual(PRS_FETCH_TIMEOUT_MS);
    } finally {
      Date.now = realNow;
    }
  });

  it('fails the whole fetch when page 2 fails, rather than give a list it knows is short', async () => {
    const { runFile } = fakeRunFile([searchPage(prs(100), { total: 150, hasNextPage: true, endCursor: 'abc' }), new RunError('timeout', 'timed out after 30s')]);
    expect(await authored({ runFile })).toEqual({ ok: false, reason: 'error', error: FETCH_ERRORS.timeout });
    const unreadable = fakeRunFile([searchPage(prs(100), { total: 150, hasNextPage: true, endCursor: 'abc' }), 'not json']);
    expect(await authored({ runFile: unreadable.runFile })).toEqual({ ok: false, reason: 'error', error: FETCH_ERRORS.unreadable });
  });

  it(`asks for pages of ${PRS_PAGE_SIZE}, each with the cursor of the one before, up to ${PRS_MAX} (W105)`, async () => {
    expect([PRS_PAGE_SIZE, PRS_MAX_PAGES]).toEqual([25, 8]);
    const cursor = (n: number) => Buffer.from(`cursor:${n}`).toString('base64');
    const pages = Array.from({ length: 9 }, (_, i) => searchPage(prs(25, 1 + i * 25), { total: 230, hasNextPage: true, endCursor: cursor(i + 1) }));
    const { runFile, calls } = fakeRunFile(pages);
    const result = await authored({ runFile });
    expect(calls).toHaveLength(PRS_MAX_PAGES);
    expect(calls.map((call) => fields(call.args).after)).toEqual([undefined, ...Array.from({ length: 7 }, (_, i) => cursor(i + 1))]);
    expect(result).toMatchObject({ ok: true, truncated: true });
    expect(result.ok && result.prs).toHaveLength(PRS_MAX);
  });

  it('stops at the page GitHub says is the last, and puts the pages together', async () => {
    const { runFile, calls } = fakeRunFile([
      searchPage(prs(25, 1), { total: 54, hasNextPage: true, endCursor: 'YQ==' }),
      searchPage(prs(25, 26), { total: 54, hasNextPage: true, endCursor: 'Yg==' }),
      searchPage(prs(4, 51), { total: 54, hasNextPage: false, endCursor: 'Yw==' }),
    ]);
    const result = await authored({ runFile });
    expect(calls).toHaveLength(3);
    expect(result).toMatchObject({ ok: true, truncated: false });
    expect(result.ok && result.prs.map((pr) => pr.number)).toEqual(Array.from({ length: 54 }, (_, i) => 54 - i));
  });

  it('fails the search when a later page fails, and stops at a later cursor of the wrong shape', async () => {
    const two = (third: string | Error) =>
      fakeRunFile([searchPage(prs(25, 1), { total: 60, hasNextPage: true, endCursor: 'YQ==' }), searchPage(prs(25, 26), { total: 60, hasNextPage: true, endCursor: 'Yg==' }), third]);
    expect(await authored({ runFile: two(new RunError('timeout', 'timed out after 30s')).runFile })).toEqual({ ok: false, reason: 'error', error: FETCH_ERRORS.timeout });
    const bad = fakeRunFile([searchPage(prs(25, 1), { total: 60, hasNextPage: true, endCursor: 'YQ==' }), searchPage(prs(25, 26), { total: 60, hasNextPage: true, endCursor: '@/etc/passwd' })]);
    expect(await authored({ runFile: bad.runFile })).toMatchObject({ ok: true, truncated: true });
    expect(bad.calls).toHaveLength(2);
  });

  it('gives each page only the time left of the search’s PRS_FETCH_TIMEOUT_MS', async () => {
    let clock = 0;
    const page = (n: number) => searchPage(prs(25, 1 + n * 25), { total: 100, hasNextPage: true, endCursor: 'YQ==' });
    // Each page takes 24 s: the third gets 12 s, and none is left for a fourth.
    const { runFile, calls } = fakeRunFile([page(0), page(1), page(2), page(3)], () => {
      clock += 24_000;
    });
    expect(await authored({ runFile, monotonicNow: () => clock })).toEqual({ ok: false, reason: 'error', error: FETCH_ERRORS.timeout });
    expect(calls.map((call) => call.options.timeoutMs)).toEqual([60_000, 36_000, 12_000]);
  });

  it('reads failing checks through to the list', async () => {
    const { runFile } = fakeRunFile([searchPage([prNode({ checks: rollup('FAILURE', [checkRun('lint', 'FAILURE')]) })])]);
    const result = await authored({ runFile });
    expect(result.ok && result.prs[0]).toMatchObject({ checks: 'failing', failingChecks: ['lint'] });
  });
});

describe('fetchSearch: errors', () => {
  const failWith = async (error: unknown) => {
    const runFile: RunFile = async () => {
      throw error;
    };
    return authored({ runFile });
  };

  it("says gh-missing when there's no gh on PATH", async () => {
    expect(await failWith(new RunError('not-found', 'gh was not found'))).toEqual({ ok: false, reason: 'gh-missing', error: FETCH_ERRORS['gh-missing'] });
    expect(FETCH_ERRORS['gh-missing']).toContain('https://cli.github.com');
    expect(FETCH_ERRORS['gh-missing']).toContain('gh auth login');
  });

  it("says gh-auth for gh's exit code 4, authentication required, and how to fix it", async () => {
    expect(await failWith(new RunError('exit', 'exited with code 4', 4))).toEqual({ ok: false, reason: 'gh-auth', error: FETCH_ERRORS['gh-auth'] });
    expect(FETCH_ERRORS['gh-auth']).toBe("gh isn't logged in to github.com. Run gh auth login, then Refresh.");
  });

  it('says error for anything else, in its own words', async () => {
    expect(await failWith(new RunError('exit', 'exited with code 1', 1))).toEqual({ ok: false, reason: 'error', error: exitError(1) });
    expect(exitError(1)).toBe('gh api failed with exit code 1. Check your network, or run gh auth status, then Refresh.');
    expect(await failWith(new RunError('timeout', 'timed out after 30s'))).toEqual({ ok: false, reason: 'error', error: FETCH_ERRORS.timeout });
    expect(FETCH_ERRORS.timeout).toContain('60 seconds');
    expect(await failWith(new RunError('too-large', 'printed more than 4194304 bytes'))).toEqual({ ok: false, reason: 'error', error: FETCH_ERRORS.tooLarge });
    for (const error of [new RunError('signal', 'was killed by SIGKILL'), new RunError('spawn', 'EACCES'), new Error('boom'), 'a string']) {
      expect(await failWith(error)).toEqual({ ok: false, reason: 'error', error: "gh couldn't be run. Refresh to try again." });
    }
  });

  it("never repeats gh's or the error's own text", async () => {
    const secret = 'pitwall-test-said-by-gh: example/private-repo';
    for (const error of [new RunError('exit', secret, 1), new RunError('spawn', secret), new RunError('exit', secret, 4), new Error(secret)]) {
      const result = await failWith(error);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain('pitwall-test-said-by-gh');
    }
  });

  it("says error for an answer it can't read, without quoting it", async () => {
    for (const stdout of ['', '<html>rate limited</html>', '{"errors":[{"message":"pitwall-test-said-by-github"}]}', '{"data":{"search":null}}']) {
      const { runFile } = fakeRunFile([stdout]);
      const result = await authored({ runFile });
      expect(result, stdout).toEqual({ ok: false, reason: 'error', error: FETCH_ERRORS.unreadable });
    }
  });
});

describe('fetchPullRequests: three searches, one call each (W101)', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 20) + minutes * 60_000).toISOString().replace('.000', '');
  const node = (repo: string, number: number, minutes: number, extra: Record<string, unknown> = {}) => prNode({ repo, number, updatedAt: at(minutes), ...extra });

  /** A runFile that answers each search with `answers[relation]`, in turn: stdout, or an error to reject with. */
  function bySearch(answers: Partial<Record<PullRequestRelation, (string | Error)[]>>, onCall?: (call: Call) => void) {
    const calls: Call[] = [];
    const runFile: RunFile = async (file, args, options) => {
      const call = { file, args, options };
      calls.push(call);
      onCall?.(call);
      const relation = relationOf(args);
      const answer = relation === undefined ? undefined : answers[relation]?.shift();
      if (answer === undefined) return searchPage([]);
      if (answer instanceof Error) throw answer;
      return answer;
    };
    return { runFile, calls };
  }

  it('starts all three at once, rather than one after another', async () => {
    const started: PullRequestRelation[] = [];
    const waiting: (() => void)[] = [];
    const runFile: RunFile = (_file, args) => {
      started.push(relationOf(args)!);
      return new Promise((resolve) => waiting.push(() => resolve(searchPage([]))));
    };
    const fetch = fetchPullRequests({ runFile });
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual([...PR_RELATIONS]);
    for (const resolve of waiting) resolve();
    expect(Object.keys(await fetch)).toEqual([...PR_RELATIONS]);
  });

  it('gives each search its PRs, with its relation, and the review-requested one whether it asked you or a team', async () => {
    const { runFile } = bySearch({
      authored: [searchPage([node('example/demo-app', 1, 10)])],
      'review-requested': [searchPage([node('example/event-relay', 2, 30, { reviewRequests: reviewRequests({ user: VIEWER }) }), node('example/event-relay', 3, 20, { reviewRequests: reviewRequests({ team: 'example/reviewers' }) })])],
      mentioned: [searchPage([node('example/api-server', 4, 20)], { viewer: null })],
    });
    const result = await fetchPullRequests({ runFile });
    expect(Object.fromEntries(PR_RELATIONS.map((relation) => [relation, result[relation].ok && result[relation].prs.map((pr) => [pr.number, pr.relation, pr.reviewRequest ?? null])]))).toEqual({
      authored: [[1, 'authored', null]],
      'review-requested': [
        [2, 'review-requested', { via: 'direct' }],
        [3, 'review-requested', { via: 'team', team: 'example/reviewers' }],
      ],
      mentioned: [[4, 'mentioned', null]],
    });
  });

  it('fails one search alone: the others keep their PRs', async () => {
    const { runFile } = bySearch({
      authored: [searchPage([node('example/demo-app', 1, 10)])],
      'review-requested': [new RunError('exit', 'exited with code 1', 1)],
      mentioned: ['not json'],
    });
    const result = await fetchPullRequests({ runFile });
    expect(result.authored).toMatchObject({ ok: true, prs: [{ number: 1 }] });
    expect(result['review-requested']).toEqual({ ok: false, reason: 'error', error: exitError(1) });
    expect(result.mentioned).toEqual({ ok: false, reason: 'error', error: FETCH_ERRORS.unreadable });
  });

  it('gives each search its own deadline, so a slow one times out alone', async () => {
    let clock = 0;
    const page1 = searchPage(Array.from({ length: 100 }, (_, i) => node('example/demo-app', i + 1, i)), { total: 150, hasNextPage: true, endCursor: 'YQ==' });
    const { runFile, calls } = bySearch({ mentioned: [page1, searchPage([])], authored: [searchPage([node('example/demo-app', 500, 1)])] }, (call) => {
      // The mention search's page 1 takes the whole timeout.
      if (relationOf(call.args) === 'mentioned' && !call.args.some((arg) => arg.startsWith('after='))) clock += PRS_FETCH_TIMEOUT_MS;
    });
    const result = await fetchPullRequests({ runFile, monotonicNow: () => clock });
    expect(result.mentioned).toEqual({ ok: false, reason: 'error', error: FETCH_ERRORS.timeout });
    expect(result.authored).toMatchObject({ ok: true, prs: [{ number: 500 }] });
    expect(calls.filter((call) => relationOf(call.args) === 'mentioned')).toHaveLength(1);
  });

  it('fetches page 2 only for a search that has one, with its own cursor', async () => {
    const many = Array.from({ length: 100 }, (_, i) => node('example/event-relay', i + 1, i));
    const { runFile, calls } = bySearch({
      'review-requested': [searchPage(many, { total: 120, hasNextPage: true, endCursor: 'cmV2aWV3' }), searchPage(Array.from({ length: 20 }, (_, i) => node('example/event-relay', 101 + i, 200 + i)), { total: 120 })],
    });
    const result = await fetchPullRequests({ runFile });
    expect(calls).toHaveLength(4);
    expect(calls.filter((call) => call.args.some((arg) => arg.startsWith('after=')))).toEqual([expect.objectContaining({ args: ghArgs('review-requested', 'cmV2aWV3') })]);
    expect(result['review-requested']).toMatchObject({ ok: true, truncated: false });
    expect(result['review-requested'].ok && result['review-requested'].prs).toHaveLength(120);
  });

  it(`keeps ${PRS_MAX} of each search, so one with many can't crowd another out`, async () => {
    const page = (from: number, next: boolean) => searchPage(Array.from({ length: 100 }, (_, i) => node('example/demo-app', from + i, 1000 - from - i)), { total: 250, hasNextPage: next, endCursor: 'Yg==' });
    const { runFile } = bySearch({ authored: [page(1, true), page(101, true)], mentioned: [searchPage([node('example/api-server', 5, 1)])] });
    const result = await fetchPullRequests({ runFile });
    expect(result.authored).toMatchObject({ ok: true, truncated: true });
    expect(result.authored.ok && result.authored.prs).toHaveLength(PRS_MAX);
    expect(result.mentioned).toMatchObject({ ok: true, truncated: false, prs: [{ number: 5 }] });
  });

  it("leaves out a review-requested PR whose own requests have moved on from you, as GitHub's index lags a review, and doesn't take that for a change in shape", async () => {
    const reviewed = node('example/demo-app', 7, 5, { reviewRequests: reviewRequests() });
    const someoneElse = node('example/demo-app', 8, 6, { reviewRequests: reviewRequests({ user: 'someone-else' }) });
    const still = node('example/demo-app', 9, 4, { reviewRequests: reviewRequests({ user: VIEWER }) });
    const { runFile } = bySearch({ 'review-requested': [searchPage([reviewed, someoneElse, still])] });
    expect((await fetchPullRequests({ runFile }))['review-requested']).toEqual({ ok: true, prs: [parsePullRequest(still, 'review-requested', VIEWER)], truncated: false });
    // Every one moved on: an empty list, not unreadable, so the last list doesn't stay.
    const all = bySearch({ 'review-requested': [searchPage([reviewed, someoneElse], { total: 2 })] });
    expect((await fetchPullRequests({ runFile: all.runFile }))['review-requested']).toEqual({ ok: true, prs: [], truncated: false });
    // One that can't be read is still a change in shape.
    const broken = bySearch({ 'review-requested': [searchPage([reviewed, { changed: true }])] });
    expect((await fetchPullRequests({ runFile: broken.runFile }))['review-requested']).toEqual({ ok: false, reason: 'error', error: FETCH_ERRORS.unreadable });
  });
});

describe('mergeSearches (W101)', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 20) + minutes * 60_000).toISOString().replace('.000', '');
  const pr = (number: number, minutes: number, relation: PullRequestRelation) => parsePullRequest(prNode({ number, updatedAt: at(minutes) }), relation)!;

  it('lists a PR more than one search found once: yours before review requested, review requested before mentioned, newest update first', () => {
    const merged = mergeSearches({
      mentioned: [pr(7, 10, 'mentioned'), pr(1, 5, 'mentioned'), pr(9, 1, 'mentioned')],
      'review-requested': [pr(7, 10, 'review-requested'), pr(1, 5, 'review-requested')],
      authored: [pr(1, 5, 'authored')],
    });
    expect(merged.map((each) => [each.number, each.relation])).toEqual([
      [7, 'review-requested'],
      [1, 'authored'],
      [9, 'mentioned'],
    ]);
  });

  it('adds nothing for a search not given', () => {
    expect(mergeSearches({ mentioned: [pr(1, 1, 'mentioned')] }).map((each) => each.relation)).toEqual(['mentioned']);
    expect(mergeSearches({})).toEqual([]);
  });
});
