// One fetch of your open pull requests (M4, W93): GitHub's search through `gh api graphql`, at most
// two pages of 100, so at most PRS_MAX.
//
//   how it runs   the index's runFile (index/exec.ts): no shell, stdin and stderr ignored, and the
//                 environment scrubbed by childEnvironment(), with GH_PROMPT_DISABLED and
//                 GH_NO_UPDATE_NOTIFIER set and GH_FORCE_TTY and CLICOLOR_FORCE left out, so gh
//                 never asks, never checks for an update and prints plain JSON. In the temp
//                 directory, as stop and remove run, so the directory pitwall started in, and its
//                 git remotes, never matter. GitHub's token stays inside gh: pitwall never reads it
//   arguments     every variable with -f, a string, never -F, which reads `@value` as a file. The
//                 query and the search are constants; the only value from outside is page 2's
//                 cursor, from page 1's answer, and it's passed on only when it looks like one
//   time          PRS_FETCH_TIMEOUT_MS for the whole fetch, both pages together
//   errors        gh not on PATH is 'gh-missing'; gh's exit code 4, its documented "authentication
//                 required", is 'gh-auth'; anything else is 'error'. Each says what happened in
//                 pitwall's words, never gh's output: runFile ignores stderr, and stdout is only
//                 ever read as JSON
//   none kept     GitHub found PRs, but every one was dropped, as after a change in its answer's
//                 shape: that's 'error', unreadable, so the poller keeps the last good list rather
//                 than replace it with an empty one
//
// Measured on 2026-10-28: 50 PRs in one page, 2 of the 5,000 rate-limit points an hour, 8.5 s
// and 38 KB.
import os from 'node:os';
import { RunError, type RunFile } from '../index/exec.js';
import { PRS_FETCH_TIMEOUT_MS, PRS_MAX, type PullRequestSource, type PullRequestSummary } from '../shared/protocol.js';
import { byUpdatedNewestFirst, parseSearchPage, type SearchPage } from './parse.js';

/**
 * The search: your open PRs on github.com, in repos that aren't archived. Sorted by GitHub, newest
 * update first, so that past PRS_MAX the ones left out are the oldest.
 */
export const PRS_SEARCH = 'is:pr is:open author:@me archived:false sort:updated-desc';

/** The most PRs one page asks for: GitHub's limit. */
export const PRS_PAGE_SIZE = 100;

/** The most checks read per PR. The most on one of Phil's PRs on 2026-10-28 was 14. */
export const PRS_CONTEXTS_MAX = 100;

/**
 * The most bytes one page may print. 50 PRs with their checks were 38 KB; 100 PRs with 100 checks
 * each, with long names, stay under 4 MiB.
 */
export const PRS_PAGE_MAX_BYTES = 4 * 1024 * 1024;

/** The fields of PullRequestSummary, for one page. `$after` is null for page 1. */
export const PRS_QUERY = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: ${PRS_PAGE_SIZE}, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        url
        number
        title
        isDraft
        createdAt
        updatedAt
        headRefName
        headRepository { nameWithOwner }
        repository { nameWithOwner }
        reviewDecision
        mergeable
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
                contexts(first: ${PRS_CONTEXTS_MAX}) {
                  nodes {
                    __typename
                    ... on CheckRun { name status conclusion }
                    ... on StatusContext { context state }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

/**
 * What GitHub's search cursors look like: base64, such as `Y3Vyc29yOjEwMA==`, short, starting with
 * a letter or digit. Anything else isn't passed to gh. It goes in `after=<cursor>`, one argument,
 * so it could never be read as an option anyway.
 */
const CURSOR = /^[A-Za-z0-9][A-Za-z0-9+/=_-]{0,255}$/;

/** gh's exit code for "authentication required" (`gh help exit-codes`). */
export const GH_EXIT_AUTH = 4;

export type FetchResult =
  | { ok: true; prs: PullRequestSummary[]; truncated: boolean }
  | { ok: false; reason: Exclude<Extract<PullRequestSource, { ok: false }>['reason'], 'off'>; error: string };

export interface FetchOptions {
  runFile: RunFile;
  /** Default `gh`, found on PATH. */
  ghBin?: string;
  /** What gh's environment is made from, before runFile scrubs it. Default process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * A monotonic clock in milliseconds, for the deadline across both pages, so a change to the
   * system clock can't stretch or cut it. Default performance.now().
   */
  monotonicNow?: () => number;
  /** Default PRS_FETCH_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** The error each failure says, in pitwall's words. */
export const FETCH_ERRORS = {
  'gh-missing': "gh, GitHub's CLI, isn't installed or isn't on pitwall's PATH. Install it from https://cli.github.com, run gh auth login, then Refresh.",
  'gh-auth': "gh isn't logged in to github.com. Run gh auth login, then Refresh.",
  timeout: `GitHub didn't answer within ${PRS_FETCH_TIMEOUT_MS / 1000} seconds. Check your network, then Refresh.`,
  unreadable: "GitHub's answer couldn't be read. Refresh to try again.",
  tooLarge: "GitHub's answer was larger than pitwall reads. Refresh to try again.",
} as const;

/** gh exited with another code: say which, and how to look further. */
export function exitError(code: number | undefined): string {
  return `gh api failed${code === undefined ? '' : ` with exit code ${code}`}. Check your network, or run gh auth status, then Refresh.`;
}

/** The environment gh runs in: yours, without what would make it print for a terminal, and never prompting. */
export function ghEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
  delete result.GH_FORCE_TTY;
  delete result.CLICOLOR_FORCE;
  return result;
}

/** gh's arguments for one page. Every variable is a string field, -f. */
export function ghArgs(after?: string): string[] {
  const args = ['api', 'graphql', '--hostname', 'github.com', '-f', `query=${PRS_QUERY}`, '-f', `q=${PRS_SEARCH}`];
  if (after !== undefined) args.push('-f', `after=${after}`);
  return args;
}

/** True for a cursor of the shape GitHub's are, which is the only kind passed to gh. */
export function isWellFormedCursor(cursor: string): boolean {
  return CURSOR.test(cursor);
}

/** Your open PRs, newest update first, at most PRS_MAX; or why they couldn't be fetched. Never throws. */
export async function fetchPullRequests(options: FetchOptions): Promise<FetchResult> {
  const now = options.monotonicNow ?? (() => performance.now());
  const deadline = now() + (options.timeoutMs ?? PRS_FETCH_TIMEOUT_MS);
  const env = ghEnvironment(options.env ?? process.env);
  const page = async (after?: string): Promise<SearchPage | FetchResult> => {
    const timeoutMs = deadline - now();
    if (timeoutMs <= 0) return { ok: false, reason: 'error', error: FETCH_ERRORS.timeout };
    let stdout: string;
    try {
      stdout = await options.runFile(options.ghBin ?? 'gh', ghArgs(after), { cwd: os.tmpdir(), timeoutMs, env, maxStdoutBytes: PRS_PAGE_MAX_BYTES });
    } catch (error) {
      return failure(error);
    }
    return parseSearchPage(stdout) ?? { ok: false, reason: 'error', error: FETCH_ERRORS.unreadable };
  };

  const first = await page();
  if ('ok' in first) return first;
  const pages = [first];
  let more = first.hasNextPage;
  if (more && first.endCursor !== undefined && isWellFormedCursor(first.endCursor)) {
    const second = await page(first.endCursor);
    if ('ok' in second) return second;
    pages.push(second);
    more = second.hasNextPage;
  }

  // By URL, since a PR updated between the two pages can move from one to the other.
  const byUrl = new Map<string, PullRequestSummary>();
  for (const { prs } of pages) for (const pr of prs) if (!byUrl.has(pr.url)) byUrl.set(pr.url, pr);
  const prs = [...byUrl.values()].sort(byUpdatedNewestFirst);
  const total = first.total ?? 0;
  const returned = pages.reduce((sum, { nodes }) => sum + nodes, 0);
  if (prs.length === 0 && (returned > 0 || total > 0)) return { ok: false, reason: 'error', error: FETCH_ERRORS.unreadable };
  const truncated = more || total > PRS_MAX || prs.length > PRS_MAX;
  return { ok: true, prs: prs.slice(0, PRS_MAX), truncated };
}

function failure(error: unknown): FetchResult {
  if (error instanceof RunError) {
    if (error.reason === 'not-found') return { ok: false, reason: 'gh-missing', error: FETCH_ERRORS['gh-missing'] };
    if (error.reason === 'exit' && error.exitCode === GH_EXIT_AUTH) return { ok: false, reason: 'gh-auth', error: FETCH_ERRORS['gh-auth'] };
    if (error.reason === 'timeout') return { ok: false, reason: 'error', error: FETCH_ERRORS.timeout };
    if (error.reason === 'too-large') return { ok: false, reason: 'error', error: FETCH_ERRORS.tooLarge };
    if (error.reason === 'exit') return { ok: false, reason: 'error', error: exitError(error.exitCode) };
  }
  return { ok: false, reason: 'error', error: "gh couldn't be run. Refresh to try again." };
}
