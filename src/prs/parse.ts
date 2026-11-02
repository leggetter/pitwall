// Reads `gh api graphql`'s answer to one of fetch.ts's searches, defensively: GitHub's answer is
// data, and a PR's title is text anyone with push access to its branch can write.
//
//   the page      `data.search` with `nodes` an array, else the whole page is unreadable. Each PR
//                 gets the search's relation. `data.viewer.login`, when it's a login, for review
//                 requests
//   each node     kept only when every field the contract needs is there and well formed: a repo
//                 `owner/name` of GitHub's characters, a whole positive number, a url that is
//                 exactly https://github.com/<owner>/<name>/pull/<number> for that repo and number,
//                 a string title, a boolean isDraft and ISO 8601 times. Anything else is dropped
//   text          titles and failing checks' names as one line of plain text (plainLine(), the
//                 index's helper): terminal escapes, C0, DEL, C1 and the bidi controls removed, at
//                 most PR_TITLE_MAX characters
//   enums         an unknown value from GitHub is left out (review), or reads as GitHub not knowing
//                 (mergeable 'unknown', checks 'none'), rather than dropping the PR. Only the maps'
//                 own keys are known, so `constructor` or `__proto__` is unknown too (enumValue())
//   head          its repo and branch, or absent when the head repo is gone, or either is malformed
//   review asked  for the review-requested search (W101): 'direct' when a requested reviewer is a
//                 User whose login is the viewer's, else 'team' when any is a Team, named by its
//                 `org/slug` when it's the only one; absent when neither can be read. When the login
//                 and every request can be read and none is you or a team, the PR is left out as
//                 reviewed already: GitHub's search index lags, so a PR you've just reviewed can
//                 still come back from `review-requested:@me` while its own requests have moved on
//                 (W101's review). The page counts it (`skipped`), so it isn't taken as malformed
//
// Nothing here logs: a title from a private repo is as sensitive as session data.
import { hasUnsafeCharacters, isNonEmptyString, isRecord } from '../index/guards.js';
import { plainLine } from '../index/text.js';
import {
  GITHUB_OWNER_PATTERN,
  GITHUB_REPO_NAME_PATTERN,
  PR_FAILING_CHECKS_MAX,
  PR_TITLE_MAX,
  type PullRequestChecks,
  type PullRequestMergeable,
  type PullRequestRelation,
  type PullRequestReview,
  type PullRequestReviewRequest,
  type PullRequestSummary,
} from '../shared/protocol.js';

/** One page of the search, as read. */
export interface SearchPage {
  prs: PullRequestSummary[];
  /** How many nodes GitHub returned, before any was dropped. */
  nodes: number;
  /**
   * The `url` of every node that has one as a string, kept or not, skipped ones included, in
   * order: how fetch.ts tells that a later page repeated or missed a PR (W105).
   */
  urls: string[];
  /** How many of them were left out on purpose, as reviewed already, rather than as malformed. */
  skipped: number;
  /** How many PRs the search found in all (`issueCount`), when GitHub said. */
  total?: number;
  hasNextPage: boolean;
  /** The cursor for the next page, when GitHub gave a string. fetch.ts checks its shape before using it. */
  endCursor?: string;
}

/**
 * A GitHub owner: letters, digits, `-`, and `_` for an Enterprise Managed User's `name_shortcode`.
 * A repo name: letters, digits, `.`, `-` and `_`, but not `.` or `..`. Neither can hold a `/`, `?`,
 * `#`, `@`, `%` or space, so `owner/name` can't step outside the PR's own path in a URL. The
 * contract's patterns (W95), which the web UI uses too, so it keeps every PR this keeps.
 */
const OWNER = GITHUB_OWNER_PATTERN;
const NAME = GITHUB_REPO_NAME_PATTERN;
const REPO = new RegExp(`^(${OWNER})/(${NAME})$`);
const PR_URL = new RegExp(`^https://github\\.com/(${OWNER})/(${NAME})/pull/([1-9][0-9]{0,9})$`);
/** What GitHub's DateTime looks like: UTC, with or without fractions of a second. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
/** A branch name as GitHub gives it: no longer than git's own limit for a ref's last part. */
const BRANCH_MAX = 255;

const CHECKS: Readonly<Record<string, PullRequestChecks>> = {
  SUCCESS: 'passing',
  FAILURE: 'failing',
  ERROR: 'failing',
  PENDING: 'pending',
  EXPECTED: 'pending',
};
const REVIEWS: Readonly<Record<string, PullRequestReview>> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes-requested',
  REVIEW_REQUIRED: 'review-required',
};
const MERGEABLE: Readonly<Record<string, PullRequestMergeable>> = {
  MERGEABLE: 'clean',
  CONFLICTING: 'conflicts',
  UNKNOWN: 'unknown',
};
/** A check run's conclusions that count as failing (PullRequestSummary.failingChecks). */
const FAILED_CONCLUSIONS: ReadonlySet<string> = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
/** A commit status's states that count as failing. */
const FAILED_STATES: ReadonlySet<string> = new Set(['FAILURE', 'ERROR']);

/**
 * What `map` gives GitHub's enum `value`, or undefined for any other value. Only the map's own
 * keys count, so a value named like one of Object.prototype's properties, such as `constructor`,
 * `__proto__` or `toString`, reads as unknown rather than as a function or the prototype (W98).
 */
function enumValue<T>(map: Readonly<Record<string, T>>, value: unknown): T | undefined {
  return typeof value === 'string' && Object.hasOwn(map, value) ? map[value] : undefined;
}

/** A GitHub login: letters, digits and `-`, and `_` for an Enterprise Managed User, as an owner is. */
const LOGIN = new RegExp(`^${OWNER}$`);
/** A team's `org/slug`, as Team.combinedSlug gives it. */
const TEAM = new RegExp(`^(${OWNER})/(${NAME})$`);

/**
 * One page of a search, its PRs with the search's relation, or undefined when it isn't one: not
 * JSON, or without `data.search.nodes`.
 */
export function parseSearchResponse(stdout: string, relation: PullRequestRelation = 'authored'): SearchPage | undefined {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const data = isRecord(json) && isRecord(json.data) ? json.data : undefined;
  if (data === undefined) return undefined;
  const login = isRecord(data.viewer) && typeof data.viewer.login === 'string' && LOGIN.test(data.viewer.login) ? data.viewer.login : undefined;
  return parseSearchPage(data.search, relation, login);
}

/**
 * One search's page, its PRs with the search's relation, or undefined when it isn't one: without
 * `nodes`. `viewer` is your login, for whether a review request names you.
 */
export function parseSearchPage(search: unknown, relation: PullRequestRelation = 'authored', viewer?: string): SearchPage | undefined {
  if (!isRecord(search) || !Array.isArray(search.nodes)) return undefined;
  const prs: PullRequestSummary[] = [];
  const urls: string[] = [];
  let skipped = 0;
  for (const node of search.nodes) {
    if (isRecord(node) && typeof node.url === 'string') urls.push(node.url);
    const pr = readPullRequest(node, relation, viewer);
    if (pr === 'reviewed') skipped += 1;
    else if (pr !== undefined) prs.push(pr);
  }
  const pageInfo = isRecord(search.pageInfo) ? search.pageInfo : {};
  const page: SearchPage = { prs, nodes: search.nodes.length, urls, skipped, hasNextPage: pageInfo.hasNextPage === true };
  if (typeof search.issueCount === 'number' && Number.isSafeInteger(search.issueCount) && search.issueCount >= 0) page.total = search.issueCount;
  if (typeof pageInfo.endCursor === 'string') page.endCursor = pageInfo.endCursor;
  return page;
}

/**
 * One search result as a PullRequestSummary, with the relation of the search that found it, or
 * undefined when it's malformed or not a PR. For 'review-requested', `viewer` is your login, which
 * says whether the request names you.
 */
export function parsePullRequest(node: unknown, relation: PullRequestRelation = 'authored', viewer?: string): PullRequestSummary | undefined {
  const pr = readPullRequest(node, relation, viewer);
  return pr === 'reviewed' ? undefined : pr;
}

/** parsePullRequest(), or 'reviewed' for a review-requested PR whose own requests have moved on from you. */
function readPullRequest(node: unknown, relation: PullRequestRelation, viewer: string | undefined): PullRequestSummary | 'reviewed' | undefined {
  if (!isRecord(node)) return undefined;
  const repoLabel = repoName(isRecord(node.repository) ? node.repository.nameWithOwner : undefined);
  if (repoLabel === undefined) return undefined;
  const { number, url, title, isDraft } = node;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) return undefined;
  if (typeof url !== 'string' || !isPullRequestUrl(url, repoLabel, number)) return undefined;
  if (typeof title !== 'string' || typeof isDraft !== 'boolean') return undefined;
  const createdAt = isoTime(node.createdAt);
  const updatedAt = isoTime(node.updatedAt);
  if (createdAt === undefined || updatedAt === undefined) return undefined;

  const pr: PullRequestSummary = {
    url,
    repo: repoLabel.toLowerCase(),
    repoLabel,
    number,
    title: cleanText(title),
    draft: isDraft,
    createdAt,
    updatedAt,
    checks: 'none',
    mergeable: enumValue(MERGEABLE, node.mergeable) ?? 'unknown',
    relation,
  };
  const head = headOf(node);
  if (head !== undefined) pr.head = head;
  Object.assign(pr, checksOf(node.commits));
  const review = enumValue(REVIEWS, node.reviewDecision);
  if (review !== undefined) pr.review = review;
  if (relation === 'review-requested') {
    const request = reviewRequestOf(node.reviewRequests, viewer);
    if (request === 'none') return 'reviewed';
    if (request !== undefined) pr.reviewRequest = request;
  }
  return pr;
}

/**
 * Whether the PR's review requests name you or a team (W101). GitHub's search found it, so one of
 * them should be yours: one of a User whose login is yours, compared without case as GitHub's are,
 * is 'direct'; otherwise one of a Team is 'team', named when it's the only team asked.
 *
 * 'none' when your login and every request can be read, and none is you or a team: the search's
 * index is behind the PR, as just after you've reviewed it, so it doesn't ask you now. Undefined
 * when it can't say: no list, a request it can't read, or your login unknown, which can't rule out
 * one of you by name.
 */
export function reviewRequestOf(requests: unknown, viewer: string | undefined): PullRequestReviewRequest | 'none' | undefined {
  if (!isRecord(requests) || !Array.isArray(requests.nodes)) return undefined;
  const me = viewer?.toLowerCase();
  /** Each team asked: its `org/slug`, or undefined when that can't be read. */
  const teams: (string | undefined)[] = [];
  let unreadable = false;
  for (const node of requests.nodes) {
    const reviewer = isRecord(node) ? node.requestedReviewer : undefined;
    if (!isRecord(reviewer) || typeof reviewer.__typename !== 'string') {
      unreadable = true;
      continue;
    }
    if (reviewer.__typename === 'User' && me !== undefined && typeof reviewer.login === 'string' && reviewer.login.toLowerCase() === me) return { via: 'direct' };
    if (reviewer.__typename === 'Team') {
      const slug = reviewer.combinedSlug;
      const match = typeof slug === 'string' ? TEAM.exec(slug) : null;
      teams.push(match !== null && match[2] !== '.' && match[2] !== '..' ? (slug as string) : undefined);
    }
  }
  // A login that couldn't be read can't rule out a request of you by name.
  if (me === undefined) return undefined;
  if (teams.length === 0) return unreadable ? undefined : 'none';
  const [only] = teams;
  return teams.length === 1 && only !== undefined ? { via: 'team', team: only } : { via: 'team' };
}

/**
 * True when `url` is exactly `https://github.com/<owner>/<name>/pull/<number>` for this PR's own
 * repo and number. GitHub's owner and repo names don't depend on case, so neither does the match.
 */
export function isPullRequestUrl(url: string, repoLabel: string, number: number): boolean {
  const match = PR_URL.exec(url);
  if (match === null) return false;
  const [, owner, name, digits] = match as unknown as [string, string, string, string];
  if (name === '.' || name === '..') return false;
  return `${owner}/${name}`.toLowerCase() === repoLabel.toLowerCase() && Number(digits) === number;
}

/** A title or a check's name as one line of plain text, without control or bidi control characters, at most PR_TITLE_MAX. */
export function cleanText(text: string): string {
  return plainLine(text, PR_TITLE_MAX);
}

/** `owner/name` as GitHub spells it, or undefined when it isn't one. */
function repoName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = REPO.exec(value);
  if (match === null || match[2] === '.' || match[2] === '..') return undefined;
  return value;
}

function isoTime(value: unknown): string | undefined {
  return typeof value === 'string' && ISO_TIME.test(value) && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

/**
 * The head repo, lowercase, and branch. Absent when GitHub reports no head repo, as when a fork
 * was deleted, and when the branch isn't a name pitwall can compare and show as it is: empty, too
 * long, or with a control or bidi character (git allows the bidi ones).
 */
function headOf(node: Record<string, unknown>): PullRequestSummary['head'] {
  const repo = repoName(isRecord(node.headRepository) ? node.headRepository.nameWithOwner : undefined);
  const branch = node.headRefName;
  if (repo === undefined || !isNonEmptyString(branch) || branch.length > BRANCH_MAX || hasUnsafeCharacters(branch)) return undefined;
  return { repo: repo.toLowerCase(), branch };
}

/** The latest commit's rollup, and when it's failing, the failing checks' names. */
function checksOf(commits: unknown): Pick<PullRequestSummary, 'checks' | 'failingChecks' | 'failingCount'> {
  const nodes = isRecord(commits) && Array.isArray(commits.nodes) ? commits.nodes : [];
  const last: unknown = nodes[nodes.length - 1];
  const commit = isRecord(last) ? last.commit : undefined;
  const rollup = isRecord(commit) ? commit.statusCheckRollup : undefined;
  if (!isRecord(rollup)) return { checks: 'none' };
  const checks = enumValue(CHECKS, rollup.state) ?? 'none';
  if (checks !== 'failing') return { checks };
  const names = failingNames(rollup.contexts);
  if (names.length === 0) return { checks };
  const result: Pick<PullRequestSummary, 'checks' | 'failingChecks' | 'failingCount'> = {
    checks,
    failingChecks: names.slice(0, PR_FAILING_CHECKS_MAX),
  };
  if (names.length > PR_FAILING_CHECKS_MAX) result.failingCount = names.length;
  return result;
}

/** The distinct names of the failing check runs and commit statuses, in GitHub's order. */
function failingNames(contexts: unknown): string[] {
  const nodes = isRecord(contexts) && Array.isArray(contexts.nodes) ? contexts.nodes : [];
  const names = new Set<string>();
  for (const context of nodes) {
    if (!isRecord(context)) continue;
    let raw: unknown;
    if (context.__typename === 'CheckRun' && typeof context.conclusion === 'string' && FAILED_CONCLUSIONS.has(context.conclusion)) {
      raw = context.name;
    } else if (context.__typename === 'StatusContext' && typeof context.state === 'string' && FAILED_STATES.has(context.state)) {
      raw = context.context;
    }
    if (typeof raw !== 'string') continue;
    const name = cleanText(raw);
    if (name !== '') names.add(name);
  }
  return [...names];
}

/** Newest updatedAt first; the same time by URL, so one list always sorts the same way. */
export function byUpdatedNewestFirst(a: PullRequestSummary, b: PullRequestSummary): number {
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
}
