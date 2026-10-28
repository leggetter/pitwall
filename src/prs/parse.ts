// Reads one page of `gh api graphql`'s answer to the search in fetch.ts, defensively: GitHub's
// answer is data, and a PR's title is text anyone with push access to its branch can write.
//
//   the page      `data.search` with `nodes` an array, else the whole page is unreadable
//   each node     kept only when every field the contract needs is there and well formed: a repo
//                 `owner/name` of GitHub's characters, a whole positive number, a url that is
//                 exactly https://github.com/<owner>/<name>/pull/<number> for that repo and number,
//                 a string title, a boolean isDraft and ISO 8601 times. Anything else is dropped
//   text          titles and failing checks' names as one line of plain text (plainLine(), the
//                 index's helper): terminal escapes, C0, DEL, C1 and the bidi controls removed, at
//                 most PR_TITLE_MAX characters
//   enums         an unknown value from GitHub is left out (review), or reads as GitHub not knowing
//                 (mergeable 'unknown', checks 'none'), rather than dropping the PR
//   head          its repo and branch, or absent when the head repo is gone, or either is malformed
//
// Nothing here logs: a title from a private repo is as sensitive as session data.
import { hasUnsafeCharacters, isNonEmptyString, isRecord } from '../index/guards.js';
import { plainLine } from '../index/text.js';
import {
  PR_FAILING_CHECKS_MAX,
  PR_TITLE_MAX,
  type PullRequestChecks,
  type PullRequestMergeable,
  type PullRequestReview,
  type PullRequestSummary,
} from '../shared/protocol.js';

/** One page of the search, as read. */
export interface SearchPage {
  prs: PullRequestSummary[];
  /** How many PRs the search found in all (`issueCount`), when GitHub said. */
  total?: number;
  hasNextPage: boolean;
  /** The cursor for the next page, when GitHub gave a string. fetch.ts checks its shape before using it. */
  endCursor?: string;
}

/**
 * A GitHub owner: letters, digits, `-`, and `_` for an Enterprise Managed User's `name_shortcode`.
 * A repo name: letters, digits, `.`, `-` and `_`, but not `.` or `..`. Neither can hold a `/`, `?`,
 * `#`, `@`, `%` or space, so `owner/name` can't step outside the PR's own path in a URL.
 */
const OWNER = '[A-Za-z0-9][A-Za-z0-9_-]{0,99}';
const NAME = '[A-Za-z0-9._-]{1,100}';
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

/** A JSON page of the search, or undefined when it isn't one: not JSON, or without `data.search.nodes`. */
export function parseSearchPage(stdout: string): SearchPage | undefined {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const search = isRecord(json) && isRecord(json.data) ? json.data.search : undefined;
  if (!isRecord(search) || !Array.isArray(search.nodes)) return undefined;
  const prs: PullRequestSummary[] = [];
  for (const node of search.nodes) {
    const pr = parsePullRequest(node);
    if (pr !== undefined) prs.push(pr);
  }
  const pageInfo = isRecord(search.pageInfo) ? search.pageInfo : {};
  const page: SearchPage = { prs, hasNextPage: pageInfo.hasNextPage === true };
  if (typeof search.issueCount === 'number' && Number.isSafeInteger(search.issueCount) && search.issueCount >= 0) page.total = search.issueCount;
  if (typeof pageInfo.endCursor === 'string') page.endCursor = pageInfo.endCursor;
  return page;
}

/** One search result as a PullRequestSummary, or undefined when it's malformed or not a PR. */
export function parsePullRequest(node: unknown): PullRequestSummary | undefined {
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
    mergeable: (typeof node.mergeable === 'string' ? MERGEABLE[node.mergeable] : undefined) ?? 'unknown',
  };
  const head = headOf(node);
  if (head !== undefined) pr.head = head;
  Object.assign(pr, checksOf(node.commits));
  const review = typeof node.reviewDecision === 'string' ? REVIEWS[node.reviewDecision] : undefined;
  if (review !== undefined) pr.review = review;
  return pr;
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
  const checks = (typeof rollup.state === 'string' ? CHECKS[rollup.state] : undefined) ?? 'none';
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
