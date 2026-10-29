// One fetch of your open pull requests (M4, W93; W101): GitHub's search through `gh api graphql`,
// three searches in one call, as aliases: the PRs you opened, those whose review is requested of
// you, and those that mention you (PullRequestRelation, PRS_SEARCHES). At most two pages of 100 for
// each, so at most PRS_MAX of each.
//
//   how it runs   the index's runFile (index/exec.ts): no shell, stdin and stderr ignored, and the
//                 environment scrubbed by childEnvironment(), with GH_PROMPT_DISABLED and
//                 GH_NO_UPDATE_NOTIFIER set and GH_FORCE_TTY and CLICOLOR_FORCE left out, so gh
//                 never asks, never checks for an update and prints plain JSON. In the temp
//                 directory, as stop and remove run, so the directory pitwall started in, and its
//                 git remotes, never matter. GitHub's token stays inside gh: pitwall never reads it
//   calls         one, with page 1 of all three searches. Only when a search has more than 100 is
//                 there a second, with page 2 of each search that has one, as W93's single search
//                 had it
//   arguments     every variable with -f, a string, never -F, which reads `@value` as a file. The
//                 query and the searches are constants; the only values from outside are page 2's
//                 cursors, from page 1's answer, each passed on only when it looks like one
//   time          PRS_FETCH_TIMEOUT_MS for the whole fetch, both calls together
//   the list      each search's PRs, at most PRS_MAX of each, newest update first, then each PR
//                 once, as the first relation in PR_RELATIONS that found it, so a PR that's yours
//                 and mentions you is yours, and one that asks your review and mentions you asks it
//   errors        gh not on PATH is 'gh-missing'; gh's exit code 4, its documented "authentication
//                 required", is 'gh-auth'; anything else is 'error'. Each says what happened in
//                 pitwall's words, never gh's output: runFile ignores stderr, and stdout is only
//                 ever read as JSON
//   none kept     GitHub found PRs, but every one was dropped, as after a change in its answer's
//                 shape: that's 'error', unreadable, so the poller keeps the last good list rather
//                 than replace it with an empty one
//
// Measured on 2026-10-28, for the author search alone: 50 PRs in one page, 2 of the 5,000
// rate-limit points an hour, 8.5 s and 38 KB. With W101's three searches, see PLAN.md (W101).
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
import { PRS_ALIASES, PRS_SEARCHES } from './searches.js';

export { PRS_ALIASES, PRS_SEARCHES } from './searches.js';

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
 * The most bytes one call may print. 50 PRs with their checks were 38 KB; three searches of 100 PRs
 * with 100 checks each, with long names, stay under 12 MiB.
 */
export const PRS_PAGE_MAX_BYTES = 12 * 1024 * 1024;

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

/** One search in the query, under its alias. `$<alias>After` is null for page 1. */
function searchField(relation: PullRequestRelation): string {
  const alias = PRS_ALIASES[relation];
  const extra = relation === 'review-requested' ? `\n        ${PRS_REVIEW_REQUESTS}` : '';
  return `  ${alias}: search(query: $${alias}, type: ISSUE, first: ${PRS_PAGE_SIZE}, after: $${alias}After) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        ...pr${extra}
      }
    }
  }`;
}

/**
 * The query for the given searches, each under its alias, with the viewer's login, which says
 * whether a review request names you. Made only from constants, in PR_RELATIONS' order.
 */
export function prsQuery(relations: readonly PullRequestRelation[] = PR_RELATIONS): string {
  const wanted = PR_RELATIONS.filter((relation) => relations.includes(relation));
  const variables = wanted.flatMap((relation) => [`$${PRS_ALIASES[relation]}: String!`, `$${PRS_ALIASES[relation]}After: String`]).join(', ');
  return `query(${variables}) {
  viewer { login }
${wanted.map(searchField).join('\n')}
}
${PRS_FRAGMENT}`;
}

/** The query with every search: page 1's. */
export const PRS_QUERY = prsQuery();

/**
 * What GitHub's search cursors look like: base64, such as `Y3Vyc29yOjEwMA==`, short, starting with
 * a letter or digit. Anything else isn't passed to gh. It goes in `<alias>After=<cursor>`, one
 * argument, so it could never be read as an option anyway.
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
   * A monotonic clock in milliseconds, for the deadline across both calls, so a change to the
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

/** One search in a call: which, and for page 2, the cursor page 1 gave it. */
export interface SearchRequest {
  relation: PullRequestRelation;
  after?: string;
}

/**
 * gh's arguments for one call: page 1 of every search, or page 2 of those given. Every variable is a
 * string field, -f: each search's text, and on page 2 each one's cursor.
 */
export function ghArgs(searches: readonly SearchRequest[] = PR_RELATIONS.map((relation) => ({ relation }))): string[] {
  const relations = searches.map(({ relation }) => relation);
  const args = ['api', 'graphql', '--hostname', 'github.com', '-f', `query=${prsQuery(relations)}`];
  for (const relation of PR_RELATIONS) {
    const search = searches.find((each) => each.relation === relation);
    if (search === undefined) continue;
    const alias = PRS_ALIASES[relation];
    args.push('-f', `${alias}=${PRS_SEARCHES[relation]}`);
    if (search.after !== undefined) args.push('-f', `${alias}After=${search.after}`);
  }
  return args;
}

/** True for a cursor of the shape GitHub's are, which is the only kind passed to gh. */
export function isWellFormedCursor(cursor: string): boolean {
  return CURSOR.test(cursor);
}

/**
 * Your open PRs, those you opened, those that want your review and those that mention you, each
 * once, newest update first, at most PRS_MAX from each search; or why they couldn't be fetched.
 * Never throws.
 */
export async function fetchPullRequests(options: FetchOptions): Promise<FetchResult> {
  const now = options.monotonicNow ?? (() => performance.now());
  const deadline = now() + (options.timeoutMs ?? PRS_FETCH_TIMEOUT_MS);
  const env = ghEnvironment(options.env ?? process.env);
  const call = async (searches: readonly SearchRequest[]): Promise<Partial<Record<PullRequestRelation, SearchPage>> | FetchResult> => {
    const timeoutMs = deadline - now();
    if (timeoutMs <= 0) return { ok: false, reason: 'error', error: FETCH_ERRORS.timeout };
    let stdout: string;
    try {
      stdout = await options.runFile(options.ghBin ?? 'gh', ghArgs(searches), { cwd: os.tmpdir(), timeoutMs, env, maxStdoutBytes: PRS_PAGE_MAX_BYTES });
    } catch (error) {
      return failure(error);
    }
    return parseSearchResponse(stdout, searches.map(({ relation }) => relation)) ?? { ok: false, reason: 'error', error: FETCH_ERRORS.unreadable };
  };

  const first = await call(PR_RELATIONS.map((relation) => ({ relation })));
  if ('ok' in first) return first;
  const pages = new Map<PullRequestRelation, SearchPage[]>(PR_RELATIONS.map((relation) => [relation, [first[relation]!]]));
  const more = new Map<PullRequestRelation, boolean>(PR_RELATIONS.map((relation) => [relation, first[relation]!.hasNextPage]));
  const second = PR_RELATIONS.flatMap((relation): SearchRequest[] => {
    const page = first[relation]!;
    return page.hasNextPage && page.endCursor !== undefined && isWellFormedCursor(page.endCursor) ? [{ relation, after: page.endCursor }] : [];
  });
  if (second.length > 0) {
    const next = await call(second);
    if ('ok' in next) return next;
    for (const { relation } of second) {
      pages.get(relation)!.push(next[relation]!);
      more.set(relation, next[relation]!.hasNextPage);
    }
  }

  // Each search on its own first: by URL, since a PR updated between the two pages can move from one
  // to the other; then its PRS_MAX newest. Then each PR once, as the first relation that found it.
  const byUrl = new Map<string, PullRequestSummary>();
  let truncated = false;
  let returned = 0;
  let total = 0;
  for (const relation of PR_RELATIONS) {
    const own = new Map<string, PullRequestSummary>();
    for (const { prs } of pages.get(relation)!) for (const pr of prs) if (!own.has(pr.url)) own.set(pr.url, pr);
    const prs = [...own.values()].sort(byUpdatedNewestFirst);
    const searchTotal = pages.get(relation)![0]!.total ?? 0;
    returned += pages.get(relation)!.reduce((sum, { nodes }) => sum + nodes, 0);
    total += searchTotal;
    if (more.get(relation) || searchTotal > PRS_MAX || prs.length > PRS_MAX) truncated = true;
    for (const pr of prs.slice(0, PRS_MAX)) if (!byUrl.has(pr.url)) byUrl.set(pr.url, pr);
  }
  const prs = [...byUrl.values()].sort(byUpdatedNewestFirst);
  if (prs.length === 0 && (returned > 0 || total > 0)) return { ok: false, reason: 'error', error: FETCH_ERRORS.unreadable };
  return { ok: true, prs, truncated };
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
