// One fetch of your open pull requests (M4, W93; W101): GitHub's search through `gh api graphql`,
// three searches, one call each, run at once: the PRs you opened, those whose review is requested
// of you and those that mention you (PullRequestRelation, PRS_SEARCHES). At most two pages of 100
// for each, so at most PRS_MAX of each.
//
//   how it runs   the index's runFile (index/exec.ts): no shell, stdin and stderr ignored, and the
//                 environment scrubbed by childEnvironment(), with GH_PROMPT_DISABLED and
//                 GH_NO_UPDATE_NOTIFIER set and GH_FORCE_TTY and CLICOLOR_FORCE left out, so gh
//                 never asks, never checks for an update and prints plain JSON. In the temp
//                 directory, as stop and remove run, so the directory pitwall started in, and its
//                 git remotes, never matter. GitHub's token stays inside gh: pitwall never reads it
//   calls         one per search, the three at once, and a second for a search with more than 100.
//                 Not one call with the three as aliases: GitHub ends a request that takes more than
//                 10 seconds, and the three together took 9.9 s on 2026-10-29 (W101's review). Apart,
//                 one that fails or is slow fails only itself: the poller keeps the others
//   arguments     every variable with -f, a string, never -F, which reads `@value` as a file. The
//                 query and the searches are constants; the only value from outside is page 2's
//                 cursor, from page 1's answer, and it's passed on only when it looks like one
//   time          PRS_FETCH_TIMEOUT_MS for each search, both its pages together
//   each search   its PRs, at most PRS_MAX, newest update first. mergeSearches() then lists each PR
//                 once, as the first relation in PR_RELATIONS that found it, so a PR that's yours
//                 and mentions you is yours, and one that asks your review and mentions you asks it
//   errors        gh not on PATH is 'gh-missing'; gh's exit code 4, its documented "authentication
//                 required", is 'gh-auth'; anything else is 'error'. Each says what happened in
//                 pitwall's words, never gh's output: runFile ignores stderr, and stdout is only
//                 ever read as JSON
//   none kept     GitHub found PRs, but every one was dropped as malformed, as after a change in its
//                 answer's shape: that search is 'error', unreadable, so the poller keeps its last
//                 good list rather than replace it with an empty one. One left out as reviewed
//                 already (parse.ts) isn't malformed
//
// Measured on 2026-10-29, by hand: yours 2 of the 5,000 rate-limit points an hour, 9.4 s for 54
// PRs; review requested 3 points, 1.7 s; mentioned 2 points, 2.6 s. 7 points a fetch (PLAN.md, W101).
import os from 'node:os';
import { RunError, type RunFile } from '../index/exec.js';
import {
  PR_RELATIONS,
  PRS_FETCH_TIMEOUT_MS,
  PRS_MAX,
  type PullRequestRelation,
  type PullRequestSource,
  type PullRequestSummary,
} from '../shared/protocol.js';
import { byUpdatedNewestFirst, parseSearchResponse, type SearchPage } from './parse.js';

/**
 * The searches, one per relation: open PRs on github.com, in repos that aren't archived, sorted by
 * GitHub, newest update first, so that past PRS_MAX the ones left out are the oldest.
 *
 * - `review-requested:@me` finds a request of you or of a team you're on; `user-review-requested:@me`
 *   finds only those of you by name (GitHub's search docs). pitwall uses the first, as GitHub's own
 *   Review requests list does, and tells the two apart from each PR's review requests.
 * - The two that aren't yours leave out your own PRs (`-author:@me`), so they can't take their
 *   PRS_MAX: one of yours that asks a team you're on, or mentions you, is listed as yours anyway.
 *   One that asks your review and mentions you is listed as review requested.
 */
export const PRS_SEARCHES: Readonly<Record<PullRequestRelation, string>> = {
  authored: 'is:pr is:open author:@me archived:false sort:updated-desc',
  'review-requested': 'is:pr is:open review-requested:@me -author:@me archived:false sort:updated-desc',
  mentioned: 'is:pr is:open mentions:@me -author:@me archived:false sort:updated-desc',
};

/** The most PRs one page asks for: GitHub's limit. */
export const PRS_PAGE_SIZE = 100;

/** The most checks read per PR. The most on one of Phil's PRs on 2026-10-28 was 14. */
export const PRS_CONTEXTS_MAX = 100;

/**
 * The most review requests read per PR, for whether yours is of you or of a team. A nested
 * connection costs one request per PR whatever its size, so 100 costs what 10 would.
 */
export const PRS_REVIEW_REQUESTS_MAX = 100;

/**
 * The most bytes one page may print. 50 PRs with their checks were 38 KB; 100 PRs with 100 checks
 * each, with long names, stay under 4 MiB.
 */
export const PRS_PAGE_MAX_BYTES = 4 * 1024 * 1024;

/** The fields of PullRequestSummary, for every search. */
export const PRS_FRAGMENT = `fragment pr on PullRequest {
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
}`;

/** For the review-requested search only: who was asked, so pitwall can say whether it was you or a team. */
export const PRS_REVIEW_REQUESTS = `reviewRequests(first: ${PRS_REVIEW_REQUESTS_MAX}) {
          nodes {
            requestedReviewer {
              __typename
              ... on User { login }
              ... on Team { combinedSlug }
            }
          }
        }`;

/**
 * The query for one search: one page, `$after` null for page 1, with the viewer's login for the
 * review-requested one, which says whether a request names you. Made only from constants.
 */
export function prsQuery(relation: PullRequestRelation): string {
  const reviews = relation === 'review-requested';
  return `query($q: String!, $after: String) {${reviews ? '\n  viewer { login }' : ''}
  search(query: $q, type: ISSUE, first: ${PRS_PAGE_SIZE}, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        ...pr${reviews ? `\n        ${PRS_REVIEW_REQUESTS}` : ''}
      }
    }
  }
}
${PRS_FRAGMENT}`;
}

/** Each search's query. */
export const PRS_QUERIES: Readonly<Record<PullRequestRelation, string>> = Object.fromEntries(PR_RELATIONS.map((relation) => [relation, prsQuery(relation)])) as Record<PullRequestRelation, string>;

/**
 * What GitHub's search cursors look like: base64, such as `Y3Vyc29yOjEwMA==`, short, starting with
 * a letter or digit. Anything else isn't passed to gh. It goes in `<alias>After=<cursor>`, one
 * argument, so it could never be read as an option anyway.
 */
const CURSOR = /^[A-Za-z0-9][A-Za-z0-9+/=_-]{0,255}$/;

/** gh's exit code for "authentication required" (`gh help exit-codes`). */
export const GH_EXIT_AUTH = 4;

/** One search's result: its PRs, or why it couldn't be fetched. */
export type SearchResult =
  | { ok: true; prs: PullRequestSummary[]; truncated: boolean }
  | { ok: false; reason: Exclude<Extract<PullRequestSource, { ok: false }>['reason'], 'off'>; error: string };

/** One fetch: each search's result, on its own, so one that failed leaves the others (W101). */
export type FetchResult = Readonly<Record<PullRequestRelation, SearchResult>>;

export interface FetchOptions {
  runFile: RunFile;
  /** Default `gh`, found on PATH. */
  ghBin?: string;
  /** What gh's environment is made from, before runFile scrubs it. Default process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * A monotonic clock in milliseconds, for each search's deadline across its pages, so a change to
   * the system clock can't stretch or cut it. Default performance.now().
   */
  monotonicNow?: () => number;
  /** For each search. Default PRS_FETCH_TIMEOUT_MS. */
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

/** gh's arguments for one page of one search. Every variable is a string field, -f. */
export function ghArgs(relation: PullRequestRelation, after?: string): string[] {
  const args = ['api', 'graphql', '--hostname', 'github.com', '-f', `query=${PRS_QUERIES[relation]}`, '-f', `q=${PRS_SEARCHES[relation]}`];
  if (after !== undefined) args.push('-f', `after=${after}`);
  return args;
}

/** True for a cursor of the shape GitHub's are, which is the only kind passed to gh. */
export function isWellFormedCursor(cursor: string): boolean {
  return CURSOR.test(cursor);
}

/**
 * Your open PRs, those that want your review and those that mention you: each search's, run at
 * once, each at most PRS_MAX, newest update first, or why that one couldn't be fetched. Never throws.
 */
export async function fetchPullRequests(options: FetchOptions): Promise<FetchResult> {
  const results = await Promise.all(PR_RELATIONS.map((relation) => fetchSearch(relation, options)));
  return Object.fromEntries(PR_RELATIONS.map((relation, index) => [relation, results[index]!])) as Record<PullRequestRelation, SearchResult>;
}

/** One search: page 1, then page 2 when there's more, within its own deadline. Never throws. */
export async function fetchSearch(relation: PullRequestRelation, options: FetchOptions): Promise<SearchResult> {
  const now = options.monotonicNow ?? (() => performance.now());
  const deadline = now() + (options.timeoutMs ?? PRS_FETCH_TIMEOUT_MS);
  const env = ghEnvironment(options.env ?? process.env);
  const page = async (after?: string): Promise<SearchPage | SearchResult> => {
    const timeoutMs = deadline - now();
    if (timeoutMs <= 0) return { ok: false, reason: 'error', error: FETCH_ERRORS.timeout };
    let stdout: string;
    try {
      stdout = await options.runFile(options.ghBin ?? 'gh', ghArgs(relation, after), { cwd: os.tmpdir(), timeoutMs, env, maxStdoutBytes: PRS_PAGE_MAX_BYTES });
    } catch (error) {
      return failure(error);
    }
    return parseSearchResponse(stdout, relation) ?? { ok: false, reason: 'error', error: FETCH_ERRORS.unreadable };
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
  // What GitHub returned that wasn't left out on purpose, as already reviewed: none kept of it is a change in shape.
  const malformedOrKept = pages.reduce((sum, { nodes, skipped }) => sum + nodes - skipped, 0);
  const skipped = pages.reduce((sum, page) => sum + page.skipped, 0);
  if (prs.length === 0 && (malformedOrKept > 0 || (total > 0 && skipped === 0))) return { ok: false, reason: 'error', error: FETCH_ERRORS.unreadable };
  const truncated = more || total > PRS_MAX || prs.length > PRS_MAX;
  return { ok: true, prs: prs.slice(0, PRS_MAX), truncated };
}

/**
 * The searches' PRs as one list: each PR once, as the first relation in PR_RELATIONS that found it,
 * newest update first. A search not given adds nothing.
 */
export function mergeSearches(lists: Partial<Record<PullRequestRelation, readonly PullRequestSummary[]>>): PullRequestSummary[] {
  const byUrl = new Map<string, PullRequestSummary>();
  for (const relation of PR_RELATIONS) for (const pr of lists[relation] ?? []) if (!byUrl.has(pr.url)) byUrl.set(pr.url, pr);
  return [...byUrl.values()].sort(byUpdatedNewestFirst);
}

function failure(error: unknown): SearchResult {
  if (error instanceof RunError) {
    if (error.reason === 'not-found') return { ok: false, reason: 'gh-missing', error: FETCH_ERRORS['gh-missing'] };
    if (error.reason === 'exit' && error.exitCode === GH_EXIT_AUTH) return { ok: false, reason: 'gh-auth', error: FETCH_ERRORS['gh-auth'] };
    if (error.reason === 'timeout') return { ok: false, reason: 'error', error: FETCH_ERRORS.timeout };
    if (error.reason === 'too-large') return { ok: false, reason: 'error', error: FETCH_ERRORS.tooLarge };
    if (error.reason === 'exit') return { ok: false, reason: 'error', error: exitError(error.exitCode) };
  }
  return { ok: false, reason: 'error', error: "gh couldn't be run. Refresh to try again." };
}
