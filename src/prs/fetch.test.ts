// One fetch (fetch.ts), with a fake runFile: no test here runs gh.
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { RunError, type RunFile, type RunOptions } from '../index/exec.js';
import { PRS_FETCH_TIMEOUT_MS, PRS_MAX } from '../shared/protocol.js';
import { checkRun, prNode, rollup, searchPage } from '../test/prs.js';
import {
  exitError,
  FETCH_ERRORS,
  fetchPullRequests,
  ghArgs,
  ghEnvironment,
  isWellFormedCursor,
  PRS_PAGE_MAX_BYTES,
  PRS_QUERY,
  PRS_SEARCH,
} from './fetch.js';

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

describe('fetchPullRequests: the command', () => {
  it('runs gh api graphql on github.com, with the query and the search as -f string fields, never -F', async () => {
    const { runFile, calls } = fakeRunFile([searchPage([])]);
    await fetchPullRequests({ runFile });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.file).toBe('gh');
    expect(call?.args.slice(0, 4)).toEqual(['api', 'graphql', '--hostname', 'github.com']);
    expect(call?.args).not.toContain('-F');
    expect(call?.args.filter((arg) => arg.startsWith('-'))).toEqual(['--hostname', '-f', '-f']);
    expect(fields(call!.args)).toEqual({ query: PRS_QUERY, q: PRS_SEARCH });
    expect(PRS_SEARCH).toBe('is:pr is:open author:@me archived:false sort:updated-desc');
  });

  it('asks for every field the contract needs', () => {
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
      'first: 100',
    ]) {
      expect(PRS_QUERY, field).toContain(field);
    }
  });

  it('runs in the temp directory, with a timeout of PRS_FETCH_TIMEOUT_MS, a cap on stdout, and an environment that never prompts', async () => {
    const env = { PATH: '/usr/bin', HOME: '/home/demo', GH_FORCE_TTY: '1', CLICOLOR_FORCE: '1', GH_TOKEN: 'kept-for-gh' };
    const { runFile, calls } = fakeRunFile([searchPage([])]);
    await fetchPullRequests({ runFile, env, monotonicNow: () => 1000 });
    const options = calls[0]!.options;
    expect(options.timeoutMs).toBe(PRS_FETCH_TIMEOUT_MS);
    expect(options.maxStdoutBytes).toBe(PRS_PAGE_MAX_BYTES);
    expect(options.env).toEqual({ PATH: '/usr/bin', HOME: '/home/demo', GH_TOKEN: 'kept-for-gh', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' });
    expect(options.cwd).toBe(os.tmpdir());
  });

  it('passes the gh it was given', async () => {
    const { runFile, calls } = fakeRunFile([searchPage([])]);
    await fetchPullRequests({ runFile, ghBin: '/opt/demo/bin/gh' });
    expect(calls[0]?.file).toBe('/opt/demo/bin/gh');
  });

  it('builds page 2 with -f after=<cursor> only', () => {
    expect(fields(ghArgs('Y3Vyc29yOjEwMA=='))).toEqual({ query: PRS_QUERY, q: PRS_SEARCH, after: 'Y3Vyc29yOjEwMA==' });
    expect(ghArgs()).not.toContain('after');
  });

  it('copies the environment rather than changing it', () => {
    const env = { GH_FORCE_TTY: '1' };
    ghEnvironment(env);
    expect(env).toEqual({ GH_FORCE_TTY: '1' });
  });
});

describe('fetchPullRequests: the list', () => {
  it('sorts the PRs by updatedAt, newest first', async () => {
    const nodes = [
      prNode({ number: 1, updatedAt: '2026-10-01T00:00:00Z' }),
      prNode({ number: 2, updatedAt: '2026-10-03T00:00:00Z' }),
      prNode({ number: 3, updatedAt: '2026-10-02T00:00:00Z' }),
    ];
    const { runFile } = fakeRunFile([searchPage(nodes)]);
    const result = await fetchPullRequests({ runFile });
    expect(result.ok && result.prs.map((pr) => pr.number)).toEqual([2, 3, 1]);
    expect(result).toMatchObject({ ok: true, truncated: false });
  });

  it('keeps what it can read and drops the rest', async () => {
    const { runFile } = fakeRunFile([searchPage([prNode({ number: 1 }), { not: 'a pr' }, prNode({ number: 2, url: 'https://evil.example/pull/2' })])]);
    const result = await fetchPullRequests({ runFile });
    expect(result.ok && result.prs.map((pr) => pr.number)).toEqual([1]);
  });

  it('fails as unreadable when GitHub returned PRs and every one was dropped, so the last good list stays', async () => {
    // As after a change in the answer's shape: nodes that are there, none of them readable.
    const changed = [{ pullRequest: { url: 'https://github.com/example/demo-app/pull/1' } }, prNode({ number: '1' }), {}];
    for (const stdout of [searchPage(changed), searchPage([], { total: 3 }), searchPage(changed, { total: 0 })]) {
      const { runFile } = fakeRunFile([stdout]);
      expect(await fetchPullRequests({ runFile }), stdout.slice(0, 80)).toEqual({ ok: false, reason: 'error', error: FETCH_ERRORS.unreadable });
    }
  });

  it('is an empty list, not a failure, when GitHub found none', async () => {
    const { runFile } = fakeRunFile([searchPage([], { total: 0 })]);
    expect(await fetchPullRequests({ runFile })).toEqual({ ok: true, prs: [], truncated: false });
  });

  it('keeps page 2’s PRs when every one on page 1 was dropped', async () => {
    const { runFile } = fakeRunFile([
      searchPage([{}, {}], { total: 3, hasNextPage: true, endCursor: 'abc' }),
      searchPage([prNode({ number: 3 })], { total: 3 }),
    ]);
    const result = await fetchPullRequests({ runFile });
    expect(result.ok && result.prs.map((pr) => pr.number)).toEqual([3]);
  });

  it('fetches page 2 with page 1’s cursor, and puts the two together, without duplicates', async () => {
    const page1 = searchPage(prs(100, 1), { total: 150, hasNextPage: true, endCursor: 'Y3Vyc29yOjEwMA==' });
    // A PR updated between the two pages can show up on both.
    const page2 = searchPage([...prs(50, 101), prNode({ number: 100, updatedAt: '2026-10-28T00:00:00Z' })], { total: 150 });
    const { runFile, calls } = fakeRunFile([page1, page2]);
    const result = await fetchPullRequests({ runFile });
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
    const result = await fetchPullRequests({ runFile });
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({ ok: true, truncated: true });
    expect(result.ok && result.prs).toHaveLength(PRS_MAX);
  });

  it('says truncated when the total is over the limit, even if page 2 says it is the last', async () => {
    const { runFile } = fakeRunFile([
      searchPage(prs(100, 1), { total: 201, hasNextPage: true, endCursor: 'abc' }),
      searchPage(prs(100, 101), { total: 201, hasNextPage: false }),
    ]);
    expect(await fetchPullRequests({ runFile })).toMatchObject({ ok: true, truncated: true });
  });

  it("doesn't pass on a cursor of the wrong shape: page 1 alone, truncated", async () => {
    for (const endCursor of ['@/etc/passwd', 'a b', '', 'x'.repeat(257), 'cursor\n', '-F', 'é']) {
      const { runFile, calls } = fakeRunFile([searchPage(prs(100), { total: 150, hasNextPage: true, endCursor })]);
      const result = await fetchPullRequests({ runFile });
      expect(calls, endCursor).toHaveLength(1);
      expect(result, endCursor).toMatchObject({ ok: true, truncated: true });
    }
    // No cursor at all, though GitHub said there's more.
    const { runFile, calls } = fakeRunFile([searchPage(prs(100), { total: 150, hasNextPage: true, endCursor: null })]);
    expect(await fetchPullRequests({ runFile })).toMatchObject({ ok: true, truncated: true });
    expect(calls).toHaveLength(1);
  });

  it('knows a cursor by its shape: base64, at most 256 characters, starting with a letter or digit', () => {
    for (const cursor of ['Y3Vyc29yOjEwMA==', 'Y3Vyc29yOjEwMA', 'abc-_+/=', 'x'.repeat(256)]) expect(isWellFormedCursor(cursor), cursor).toBe(true);
    for (const cursor of ['', '@file', '-F', '+abc', '=', 'a b', 'a\u0000', 'x'.repeat(257), 'a=b&c']) expect(isWellFormedCursor(cursor), cursor).toBe(false);
  });

  it('fetches a single page when GitHub says there is no next one', async () => {
    const { runFile, calls } = fakeRunFile([searchPage(prs(3), { hasNextPage: false, endCursor: 'abc' })]);
    expect(await fetchPullRequests({ runFile })).toMatchObject({ ok: true, truncated: false });
    expect(calls).toHaveLength(1);
  });

  it('gives page 2 only the time left of PRS_FETCH_TIMEOUT_MS, and fails when none is left', async () => {
    let clock = 0;
    const page1 = searchPage(prs(100), { total: 150, hasNextPage: true, endCursor: 'abc' });
    const { runFile, calls } = fakeRunFile([page1, searchPage(prs(50, 101))], (call) => {
      // Page 1 takes 20 s.
      if (call.args.every((arg) => !arg.startsWith('after='))) clock += 20_000;
    });
    expect(await fetchPullRequests({ runFile, monotonicNow: () => clock })).toMatchObject({ ok: true });
    expect(calls.map((call) => call.options.timeoutMs)).toEqual([30_000, 10_000]);

    clock = 0;
    const slow = fakeRunFile([page1, searchPage([])], () => {
      clock += 30_000;
    });
    expect(await fetchPullRequests({ runFile: slow.runFile, monotonicNow: () => clock })).toEqual({ ok: false, reason: 'error', error: FETCH_ERRORS.timeout });
    expect(slow.calls).toHaveLength(1);
  });

  it('times the deadline on a monotonic clock by default, so setting the system clock can’t cut it', async () => {
    const realNow = Date.now;
    let jumps = 0;
    // Each read of the wall clock is an hour on from the last.
    Date.now = () => realNow() + ++jumps * 60 * 60_000;
    try {
      const { runFile, calls } = fakeRunFile([searchPage(prs(100), { total: 150, hasNextPage: true, endCursor: 'abc' }), searchPage(prs(50, 101))]);
      expect(await fetchPullRequests({ runFile })).toMatchObject({ ok: true });
      expect(calls).toHaveLength(2);
      expect(calls[1]!.options.timeoutMs).toBeGreaterThan(PRS_FETCH_TIMEOUT_MS - 5000);
      expect(calls[1]!.options.timeoutMs).toBeLessThanOrEqual(PRS_FETCH_TIMEOUT_MS);
    } finally {
      Date.now = realNow;
    }
  });

  it('fails the whole fetch when page 2 fails, rather than give a list it knows is short', async () => {
    const { runFile } = fakeRunFile([searchPage(prs(100), { total: 150, hasNextPage: true, endCursor: 'abc' }), new RunError('timeout', 'timed out after 30s')]);
    expect(await fetchPullRequests({ runFile })).toEqual({ ok: false, reason: 'error', error: FETCH_ERRORS.timeout });
    const unreadable = fakeRunFile([searchPage(prs(100), { total: 150, hasNextPage: true, endCursor: 'abc' }), 'not json']);
    expect(await fetchPullRequests({ runFile: unreadable.runFile })).toEqual({ ok: false, reason: 'error', error: FETCH_ERRORS.unreadable });
  });

  it('reads failing checks through to the list', async () => {
    const { runFile } = fakeRunFile([searchPage([prNode({ checks: rollup('FAILURE', [checkRun('lint', 'FAILURE')]) })])]);
    const result = await fetchPullRequests({ runFile });
    expect(result.ok && result.prs[0]).toMatchObject({ checks: 'failing', failingChecks: ['lint'] });
  });
});

describe('fetchPullRequests: errors', () => {
  const failWith = async (error: unknown) => {
    const runFile: RunFile = async () => {
      throw error;
    };
    return fetchPullRequests({ runFile });
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
    expect(FETCH_ERRORS.timeout).toContain('30 seconds');
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
      const result = await fetchPullRequests({ runFile });
      expect(result, stdout).toEqual({ ok: false, reason: 'error', error: FETCH_ERRORS.unreadable });
    }
  });
});
