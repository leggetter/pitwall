// One fetch of your open pull requests (M4, W93; W101): GitHub's search through `gh api graphql`,
// three searches, one call each, run at once: the PRs you opened, those whose review is requested
// of you and those that mention you (PullRequestRelation, PRS_SEARCHES). Pages of PRS_PAGE_SIZE,
// 25, one after another, up to PRS_MAX of each (W105).
//
//   how it runs   the index's runFile (index/exec.ts): no shell, stdin and stderr ignored, and the
//                 environment scrubbed by childEnvironment(), with GH_PROMPT_DISABLED and
//                 GH_NO_UPDATE_NOTIFIER set and GH_FORCE_TTY and CLICOLOR_FORCE left out, so gh
//                 never asks, never checks for an update and prints plain JSON. In a fresh 0700
//                 directory of pitwall's own, `mkdtemp(<tmpdir>/pitwall-gh-)`, one per fetch,
//                 removed after, as W107's clone runs gh (W108's finding): never the directory
//                 pitwall started in, so its git remotes never matter, nor the shared temp
//                 directory itself, which on Linux any local user can write to; and git, should
//                 anything gh runs look for a repository, stops at the temp directory
//                 (GIT_CEILING_DIRECTORIES, ghEnvironment(), W117's review), so a `.git` planted
//                 there is never read. GitHub's token stays inside gh: pitwall never reads it
//   calls         one per page of each search, the three searches at once, each page after the one
//                 before. Not one call with the three as aliases: GitHub ends a request that takes
//                 more than 10 seconds, and the three together took 9.9 s on 2026-10-29 (W101's
//                 review). Apart, one that fails or is slow fails only itself: the poller keeps the
//                 others. Pages of 25, not 100 (W105): your own search's 54 PRs in one page took
//                 9.4 s, near GitHub's 10 s, and a page's time grows with the PRs on it
//   arguments     every variable with -f, a string, never -F, which reads `@value` as a file. The
//                 query and the searches are constants; the only value from outside is the next
//                 page's cursor, from the page before's answer, and it's passed on only when it looks
//                 like one
//   time          PRS_FETCH_TIMEOUT_MS for each pass of a search, all its pages together
//   moving PRs    GitHub's search cursors are offsets, so a PR that moves while a search is paged
//                 shifts the rest: one updated moves to the top (`sort:updated-desc`), one opened
//                 comes in at the top, one closed or merged leaves, and a later page then repeats one
//                 PR and misses another, or misses one. So a search is consistent() only when its
//                 nodes, skipped ones included, have no URL twice, and as many as GitHub's total, or
//                 PRS_MAX when it found more; when it isn't, it's fetched again once, and that pass
//                 is kept, or the first when it fails (W105's review). Not a sort that doesn't move,
//                 such as `sort:created-desc`: closing still shifts it, and past PRS_MAX it would
//                 leave out the oldest opened rather than the least recently updated
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
// In pages of 25 (W105), the same day: yours 55 PRs in 3 pages of 3.7, 4.8 and 2.9 s, 11.4 s in
// all; review requested 1.5 s; mentioned 2.6 s. A page of 25 costs 1 point by GitHub's formula.
import { realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

/**
 * The most PRs one page asks for (W105). GitHub allows 100, but a page's time grows with its PRs, each
 * with its checks: your own search's 54 in one page took 9.4 s on 2026-10-29, against GitHub's limit
 * of 10 s for a request. 25 keeps each page well under it.
 */
export const PRS_PAGE_SIZE = 25;

/** The most pages one search fetches: PRS_MAX in pages of PRS_PAGE_SIZE. */
export const PRS_MAX_PAGES = Math.ceil(PRS_MAX / PRS_PAGE_SIZE);

/** The most checks read per PR. The most on one of Phil's PRs on 2026-10-28 was 14. */
export const PRS_CONTEXTS_MAX = 100;

/**
 * The most review requests read per PR, for whether yours is of you or of a team. A nested
 * connection costs one request per PR whatever its size, so 100 costs what 10 would.
 */
export const PRS_REVIEW_REQUESTS_MAX = 100;

/**
 * The most bytes one page may print. 50 PRs with their checks were 38 KB; 100 PRs with 100 checks
 * each, with long names, stay under 4 MiB, and a page holds 25.
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
  /** The system's temp directory, where gh's own working directory goes (GH_CWD_PREFIX). Default os.tmpdir(), read per fetch. */
  tmpdir?: string;
  /**
   * gh's working directory, pitwall's own: fetchPullRequests() makes one for its three searches. A
   * search given none makes its own.
   */
  cwd?: string;
}

/** The prefix of the directory gh runs in, in the system's temp directory: pitwall's own, 0700 as mkdtemp makes it, removed after (W107, W108). */
export const GH_CWD_PREFIX = 'pitwall-gh-';

/**
 * Runs `fn` in a fresh directory of pitwall's own for gh, `mkdtemp(<tmpdir>/pitwall-gh-)`, 0700, and
 * removes it after, or gives `failed` when it can't be made.
 */
async function inGhDirectory<T>(tmpdir: string, fn: (cwd: string) => Promise<T>, failed: () => T): Promise<T> {
  let dir: string;
  try {
    dir = await mkdtemp(path.join(tmpdir, GH_CWD_PREFIX));
  } catch {
    return failed();
  }
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** The error each failure says, in pitwall's words. */
export const FETCH_ERRORS = {
  'gh-missing': "gh, GitHub's CLI, isn't installed or isn't on pitwall's PATH. Install it from https://cli.github.com, run gh auth login, then Refresh.",
  'gh-auth': "gh isn't logged in to github.com. Run gh auth login, then Refresh.",
  timeout: `GitHub didn't answer within ${PRS_FETCH_TIMEOUT_MS / 1000} seconds. Check your network, then Refresh.`,
  unreadable: "GitHub's answer couldn't be read. Refresh to try again.",
  tooLarge: "GitHub's answer was larger than pitwall reads. Refresh to try again.",
  noDirectory: "pitwall couldn't make a folder of its own in the system's temp directory for gh to run in. Check that it has room and can be written to, then Refresh.",
} as const;

/** gh exited with another code: say which, and how to look further. */
export function exitError(code: number | undefined): string {
  return `gh api failed${code === undefined ? '' : ` with exit code ${code}`}. Check your network, or run gh auth status, then Refresh.`;
}

/**
 * The environment gh runs in: yours, without what would make it print for a terminal, and never
 * prompting. And git, if anything gh runs looks for a repository from its working directory, stops at
 * the temp directory that directory is made in, `tmpdir` by the path given and its real path
 * (GIT_CEILING_DIRECTORIES, before any you set): git searches parent folders, and on Linux anyone can
 * put a `.git` in the shared temp directory (W117's review saw git 2.50 find one there).
 */
export function ghEnvironment(env: NodeJS.ProcessEnv, tmpdir: string = os.tmpdir()): NodeJS.ProcessEnv {
  const ceilings = new Set([tmpdir]);
  try {
    ceilings.add(realpathSync.native(tmpdir));
  } catch {
    // The path given alone.
  }
  if (env.GIT_CEILING_DIRECTORIES) ceilings.add(env.GIT_CEILING_DIRECTORIES);
  const result: NodeJS.ProcessEnv = { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GIT_CEILING_DIRECTORIES: [...ceilings].join(':') };
  delete result.GH_FORCE_TTY;
  delete result.CLICOLOR_FORCE;
  return result;
}

/** gh's arguments for one page of one search, `after` the cursor for any but the first. Every variable is a string field, -f. */
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
  const results = await inGhDirectory(
    options.tmpdir ?? os.tmpdir(),
    (cwd) => Promise.all(PR_RELATIONS.map((relation) => fetchSearch(relation, { ...options, cwd }))),
    () => PR_RELATIONS.map((): SearchResult => ({ ok: false, reason: 'error', error: FETCH_ERRORS.noDirectory })),
  );
  return Object.fromEntries(PR_RELATIONS.map((relation, index) => [relation, results[index]!])) as Record<PullRequestRelation, SearchResult>;
}

/** One pass of a search: its pages, or why one failed. */
type Pass = { ok: true; pages: SearchPage[] } | Extract<SearchResult, { ok: false }>;

/**
 * True when a pass's pages hold no PR twice and as many as they should: GitHub's total, from its
 * first page, when the last page said there's no more, or PRS_MAX when the pass stopped there.
 * Each node counts by its URL, skipped and malformed ones included; one without a URL counts as its
 * own. A pass that stopped at a cursor of the wrong shape is checked for repeats only.
 */
export function consistent(pages: readonly SearchPage[]): boolean {
  const nodes = pages.reduce((sum, page) => sum + page.nodes, 0);
  const urls = pages.flatMap((page) => page.urls);
  const unique = new Set(urls).size + (nodes - urls.length);
  if (unique < nodes) return false;
  const last = pages.at(-1);
  const total = pages[0]?.total;
  if (last === undefined || total === undefined) return true;
  if (!last.hasNextPage) return unique >= total;
  if (nodes >= PRS_MAX || pages.length >= PRS_MAX_PAGES) return unique >= Math.min(total, PRS_MAX);
  return true;
}

/**
 * One search: page 1, then each next page while GitHub says there's more and a cursor of the right
 * shape, until it has returned PRS_MAX or PRS_MAX_PAGES pages, all within PRS_FETCH_TIMEOUT_MS. One
 * page that fails fails the pass, rather than give a list it knows is short. A pass that isn't
 * consistent() is fetched again once, with a deadline of its own, and the second is kept, or the
 * first when the second fails. Never throws.
 */
export async function fetchSearch(relation: PullRequestRelation, options: FetchOptions): Promise<SearchResult> {
  const { cwd } = options;
  if (cwd === undefined) {
    return inGhDirectory(options.tmpdir ?? os.tmpdir(), (dir) => fetchSearch(relation, { ...options, cwd: dir }), () => ({ ok: false, reason: 'error', error: FETCH_ERRORS.noDirectory }));
  }
  const now = options.monotonicNow ?? (() => performance.now());
  const env = ghEnvironment(options.env ?? process.env, options.tmpdir ?? os.tmpdir());

  const pass = async (): Promise<Pass> => {
    const deadline = now() + (options.timeoutMs ?? PRS_FETCH_TIMEOUT_MS);
    const page = async (after?: string): Promise<SearchPage | SearchResult> => {
      const timeoutMs = deadline - now();
      if (timeoutMs <= 0) return { ok: false, reason: 'error', error: FETCH_ERRORS.timeout };
      let stdout: string;
      try {
        stdout = await options.runFile(options.ghBin ?? 'gh', ghArgs(relation, after), { cwd, timeoutMs, env, maxStdoutBytes: PRS_PAGE_MAX_BYTES });
      } catch (error) {
        return failure(error);
      }
      return parseSearchResponse(stdout, relation) ?? { ok: false, reason: 'error', error: FETCH_ERRORS.unreadable };
    };
    const first = await page();
    if ('ok' in first) return first.ok ? { ok: false, reason: 'error', error: FETCH_ERRORS.unreadable } : first;
    const pages = [first];
    let last = first;
    let nodes = first.nodes;
    while (last.hasNextPage && pages.length < PRS_MAX_PAGES && nodes < PRS_MAX && last.endCursor !== undefined && isWellFormedCursor(last.endCursor)) {
      const next = await page(last.endCursor);
      if ('ok' in next) return next.ok ? { ok: false, reason: 'error', error: FETCH_ERRORS.unreadable } : next;
      pages.push(next);
      nodes += next.nodes;
      last = next;
    }
    return { ok: true, pages };
  };

  const first = await pass();
  if (!first.ok) return first;
  let pages = first.pages;
  if (!consistent(pages)) {
    const again = await pass();
    if (again.ok) pages = again.pages;
  }
  return resultOf(pages);
}

/** A pass's PRs, each once, newest update first, at most PRS_MAX, or unreadable when none of what GitHub found could be read. */
function resultOf(pages: readonly SearchPage[]): SearchResult {
  // By URL, since a PR that moves while the pages are fetched can be on two of them.
  const byUrl = new Map<string, PullRequestSummary>();
  for (const { prs } of pages) for (const pr of prs) if (!byUrl.has(pr.url)) byUrl.set(pr.url, pr);
  const prs = [...byUrl.values()].sort(byUpdatedNewestFirst);
  const first = pages[0];
  const total = first?.total ?? 0;
  // What GitHub returned that wasn't left out on purpose, as already reviewed: none kept of it is a change in shape.
  const malformedOrKept = pages.reduce((sum, { nodes, skipped }) => sum + nodes - skipped, 0);
  const skipped = pages.reduce((sum, page) => sum + page.skipped, 0);
  if (prs.length === 0 && (malformedOrKept > 0 || (total > 0 && skipped === 0))) return { ok: false, reason: 'error', error: FETCH_ERRORS.unreadable };
  const more = pages.at(-1)?.hasNextPage === true;
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
