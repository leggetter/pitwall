// Your open pull requests in the web UI (M4, W95; docs/design-system.md, 4: Pull requests): reading
// the 'prs' message defensively, and what the screen derives from the list. Which sessions a PR is
// linked to, a session's most urgent PR, the repo headings and their order, the 90-day window, the
// filter, the attention count, the state badges, and the PR's link. All pure, so they're easy to test.
//
// The index finds each session's links without knowing which PRs are open (SessionSummary.prLinks),
// and the page matches them against the list with prLinkMatches() (src/shared/protocol.ts), so a link
// to a PR that isn't one of your open ones shows nothing. Opened, pushed and prompted links are strong:
// the session row's badge, the session view's links and the PR row's sessions use only those. A
// mentioned one, Claude naming the PR in a reply, shows only in the PR view, under Mentioned in.

import {
  PR_FAILING_CHECKS_MAX,
  PR_TITLE_MAX,
  prLinkIsStrong,
  prLinkMatches,
  prNeedsAttention,
  PRS_MAX,
  PRS_SHOWN_DAYS,
  type PrLink,
  type PullRequestChecks,
  type PullRequestList,
  type PullRequestMergeable,
  type PullRequestReview,
  type PullRequestSource,
  type PullRequestSummary,
  type SessionSummary,
} from '../../src/shared/protocol.js';
import { plainText } from './format.js';
import type { BadgeLook } from './sessions.js';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isTime = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && !Number.isNaN(Date.parse(value));

/** A lowercase `owner/name`, as GitHub allows them: what PullRequestSummary.repo and PrLink.repo hold. */
const REPO = /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/;

/** A PR's own address on github.com, and nothing more: no query, no fragment, no other host. */
const GITHUB_PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/pull\/([1-9][0-9]{0,9})$/;

/** The most characters of a check's name that the page keeps. */
const NAME_MAX = 200;

/** The longest head branch the contract keeps: a longer one, as an empty one, means no head (PullRequestSummary.head). */
const BRANCH_MAX = 255;

/** C0 and C1 controls and the bidi controls, which a head branch never has (PullRequestSummary.head). */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

const CHECKS: readonly PullRequestChecks[] = ['passing', 'failing', 'pending', 'none'];
const REVIEWS: readonly PullRequestReview[] = ['approved', 'changes-requested', 'review-required'];
const MERGEABLE: readonly PullRequestMergeable[] = ['clean', 'conflicts', 'unknown'];
const REASONS = ['off', 'gh-missing', 'gh-auth', 'error'] as const;

/**
 * `url` when it's exactly `https://github.com/<owner>/<name>/pull/<n>` for this PR's own repo and
 * number, or undefined. The server keeps only such PRs; the page checks again before it links one, so
 * Open on GitHub and Copy link can only ever go to GitHub, to that PR.
 */
export function githubPrUrl(pr: Pick<PullRequestSummary, 'url' | 'repo' | 'number'>): string | undefined {
  const match = GITHUB_PR_URL.exec(pr.url);
  if (!match) return undefined;
  const [, owner = '', name = '', number = ''] = match;
  return `${owner}/${name}`.toLowerCase() === pr.repo && Number(number) === pr.number ? pr.url : undefined;
}

function parseSource(value: unknown): PullRequestSource | undefined {
  if (!isRecord(value)) return undefined;
  if (value.ok === true) return { ok: true };
  if (value.ok !== false || typeof value.error !== 'string') return undefined;
  // A reason this page doesn't know is still a failure: shown as one it can't name.
  const reason = (REASONS as readonly unknown[]).includes(value.reason) ? (value.reason as (typeof REASONS)[number]) : 'error';
  return { ok: false, reason, error: value.error.slice(0, 500) };
}

/** One PR from the 'prs' message, or undefined when it isn't the contract's shape. */
export function parsePullRequest(value: unknown): PullRequestSummary | undefined {
  if (!isRecord(value)) return undefined;
  const { url, repo, repoLabel, number, title, draft, createdAt, updatedAt, head, checks, failingChecks, failingCount, review, mergeable } = value;
  if (typeof repo !== 'string' || !REPO.test(repo)) return undefined;
  if (typeof repoLabel !== 'string' || repoLabel.toLowerCase() !== repo) return undefined;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) return undefined;
  if (typeof url !== 'string' || githubPrUrl({ url, repo, number }) === undefined) return undefined;
  if (typeof title !== 'string' || typeof draft !== 'boolean' || !isTime(createdAt) || !isTime(updatedAt)) return undefined;
  if (!(CHECKS as readonly unknown[]).includes(checks) || !(MERGEABLE as readonly unknown[]).includes(mergeable)) return undefined;
  if (review !== undefined && !(REVIEWS as readonly unknown[]).includes(review)) return undefined;
  const pr: PullRequestSummary = {
    url,
    repo,
    repoLabel,
    number,
    title: title.slice(0, PR_TITLE_MAX),
    draft,
    createdAt,
    updatedAt,
    checks: checks as PullRequestChecks,
    mergeable: mergeable as PullRequestMergeable,
  };
  // A head that isn't the contract's shape is left out, as the server leaves out one whose repo has
  // gone, or whose branch is empty, over 255 characters, or has a control or bidi control character.
  if (isRecord(head) && typeof head.repo === 'string' && REPO.test(head.repo) && typeof head.branch === 'string') {
    const { branch } = head;
    if (branch !== '' && branch.length <= BRANCH_MAX && !CONTROL.test(branch)) pr.head = { repo: head.repo, branch };
  }
  if (review !== undefined) pr.review = review as PullRequestReview;
  if (pr.checks === 'failing' && Array.isArray(failingChecks)) {
    const names = failingChecks.filter((name): name is string => typeof name === 'string' && name !== '').slice(0, PR_FAILING_CHECKS_MAX);
    if (names.length > 0) pr.failingChecks = names.map((name) => name.slice(0, NAME_MAX));
  }
  if (pr.checks === 'failing' && typeof failingCount === 'number' && Number.isSafeInteger(failingCount) && failingCount > (pr.failingChecks?.length ?? 0)) {
    pr.failingCount = failingCount;
  }
  return pr;
}

/**
 * The 'prs' message's list, or undefined when it isn't the contract's shape: no source, no
 * `refreshing`, or `prs` that isn't a list. A PR in it that isn't the contract's shape is left out,
 * and so is a second one with the same repo and number; at most PRS_MAX are kept.
 */
export function parsePullRequestList(value: unknown): PullRequestList | undefined {
  if (!isRecord(value)) return undefined;
  const source = parseSource(value.source);
  if (!source || typeof value.refreshing !== 'boolean' || !Array.isArray(value.prs)) return undefined;
  const seen = new Set<string>();
  const prs: PullRequestSummary[] = [];
  for (const each of value.prs) {
    if (prs.length >= PRS_MAX) break;
    const pr = parsePullRequest(each);
    if (!pr || seen.has(prKey(pr))) continue;
    seen.add(prKey(pr));
    prs.push(pr);
  }
  const list: PullRequestList = { source, refreshing: value.refreshing, prs };
  if (isTime(value.fetchedAt)) list.fetchedAt = value.fetchedAt;
  if (value.truncated === true) list.truncated = true;
  return list;
}

/** A PR's identity on the page, and in `?pr=`: its lowercase repo and its number, `owner/name/123`. */
export function prKey(pr: Pick<PullRequestSummary, 'repo' | 'number'>): string {
  return `${pr.repo}/${pr.number}`;
}

/** "example/demo-app #42": a PR named on screen, its repo as GitHub spells it. */
export function prName(pr: Pick<PullRequestSummary, 'repoLabel' | 'number'>): string {
  return `${plainText(pr.repoLabel)} #${pr.number}`;
}

/** Whether pull requests are off, as with `--no-prs`: the repo list has no Pull requests item. */
export function prsOff(list: PullRequestList | undefined): boolean {
  return list?.source.ok === false && list.source.reason === 'off';
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * "Now" for the 90-day window: the list's own fetchedAt, so what's hidden changes only with a fetch, as
 * the ended sessions' window follows the snapshot's time. Date.now() before the first fetch.
 */
export function listNow(list: PullRequestList | undefined, fallback = Date.now()): number {
  const at = list?.fetchedAt === undefined ? Number.NaN : Date.parse(list.fetchedAt);
  return Number.isNaN(at) ? fallback : at;
}

/** A PR last updated more than PRS_SHOWN_DAYS before `now`: listed behind Show older. A `now` that isn't a time hides nothing. */
export function isOlderPr(pr: Pick<PullRequestSummary, 'updatedAt'>, now: number): boolean {
  const updated = Date.parse(pr.updatedAt);
  return !Number.isNaN(updated) && updated < now - PRS_SHOWN_DAYS * DAY_MS;
}

/** The PRs updated in the last PRS_SHOWN_DAYS, and the older ones, each in the order given. */
export function splitPrs(prs: readonly PullRequestSummary[], now: number): { recent: PullRequestSummary[]; older: PullRequestSummary[] } {
  const recent: PullRequestSummary[] = [];
  const older: PullRequestSummary[] = [];
  for (const pr of prs) (isOlderPr(pr, now) ? older : recent).push(pr);
  return { recent, older };
}

/** How many of `prs` need you: failing checks, conflicts or changes requested (prNeedsAttention()). */
export function countPrAttention(prs: readonly PullRequestSummary[]): number {
  return prs.reduce((count, pr) => count + (prNeedsAttention(pr) ? 1 : 0), 0);
}

const time = (iso: string) => {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? 0 : at;
};

/** Within a repo: the PRs that need attention first, then the newest updated, then the highest number. */
export function comparePrs(a: PullRequestSummary, b: PullRequestSummary): number {
  const attention = Number(prNeedsAttention(b)) - Number(prNeedsAttention(a));
  if (attention !== 0) return attention;
  return time(b.updatedAt) - time(a.updatedAt) || b.number - a.number;
}

/** One repo's heading in the PR list, and its PRs, in comparePrs() order. */
export interface PrRepo {
  /** Lowercase `owner/name`, as PullRequestSummary.repo. */
  repo: string;
  /** `owner/name` as GitHub spells it, from its newest PR. */
  label: string;
  prs: PullRequestSummary[];
  /** How many of them need attention. */
  attention: number;
}

/**
 * The PRs under one heading per repo, the headings ordered by their newest updatedAt, so the repo you
 * worked in last is first, ties by label. Within each, comparePrs().
 */
export function groupPrs(prs: readonly PullRequestSummary[]): PrRepo[] {
  const byRepo = new Map<string, PullRequestSummary[]>();
  for (const pr of prs) byRepo.set(pr.repo, [...(byRepo.get(pr.repo) ?? []), pr]);
  const newest = (list: readonly PullRequestSummary[]) => Math.max(...list.map((pr) => time(pr.updatedAt)));
  return [...byRepo.entries()]
    .map(([repo, list]) => {
      const sorted = [...list].sort(comparePrs);
      const latest = [...list].sort((a, b) => time(b.updatedAt) - time(a.updatedAt))[0];
      return { repo, label: latest?.repoLabel ?? repo, prs: sorted, attention: countPrAttention(sorted), newest: newest(list) };
    })
    .sort((a, b) => b.newest - a.newest || a.repo.localeCompare(b.repo))
    .map(({ newest: _newest, ...group }) => group);
}

/**
 * The PRs that match the filter's text, in the order given: case-insensitively, on the trimmed text,
 * in the title, the repo, the number (as "#42") and the head branch. No text matches every PR.
 */
export function filterPrs(prs: readonly PullRequestSummary[], text: string): PullRequestSummary[] {
  const needle = text.trim().toLowerCase();
  if (needle === '') return [...prs];
  return prs.filter(
    (pr) =>
      plainText(pr.title).toLowerCase().includes(needle) ||
      pr.repo.includes(needle) ||
      `#${pr.number}`.includes(needle) ||
      (pr.head?.branch.toLowerCase().includes(needle) ?? false),
  );
}

/** A session and its newest link to a PR. */
export interface LinkedSession {
  session: SessionSummary;
  link: PrLink;
}

/** The session's links that point at `pr`, newest first: by repo and number, or for 'pushed', by the PR's head. */
export function linksTo(session: SessionSummary, pr: PullRequestSummary): PrLink[] {
  return (session.prLinks ?? []).filter((link) => prLinkMatches(link, pr)).sort((a, b) => time(b.lastAt) - time(a.lastAt));
}

/**
 * The sessions linked to `pr`, each once, finished and ended ones included: those with a strong link
 * (opened, pushed or prompted), and those Claude only mentioned it in. Each list has the running ones
 * first, then the finished ones, each by its newest link of that kind.
 */
export function sessionsFor(pr: PullRequestSummary, sessions: readonly SessionSummary[]): { strong: LinkedSession[]; mentioned: LinkedSession[] } {
  const strong: LinkedSession[] = [];
  const mentioned: LinkedSession[] = [];
  const seen = new Set<string>();
  for (const session of sessions) {
    if (seen.has(session.sessionId)) continue;
    seen.add(session.sessionId);
    const links = linksTo(session, pr);
    const strongest = links.find(prLinkIsStrong);
    if (strongest) strong.push({ session, link: strongest });
    else if (links[0]) mentioned.push({ session, link: links[0] });
  }
  const order = (a: LinkedSession, b: LinkedSession) => Number(a.session.finished) - Number(b.session.finished) || time(b.link.lastAt) - time(a.link.lastAt);
  return { strong: strong.sort(order), mentioned: mentioned.sort(order) };
}

/**
 * The open PRs a session is strongly linked to, most urgent first: those that need attention, then by
 * the session's newest strong link to each. The first is its row's badge.
 */
export function prsFor(session: SessionSummary, prs: readonly PullRequestSummary[]): PullRequestSummary[] {
  if (!session.prLinks?.some(prLinkIsStrong)) return [];
  const linked = prs.flatMap((pr) => {
    const newest = linksTo(session, pr).find(prLinkIsStrong);
    return newest ? [{ pr, at: time(newest.lastAt) }] : [];
  });
  return linked.sort((a, b) => Number(prNeedsAttention(b.pr)) - Number(prNeedsAttention(a.pr)) || b.at - a.at).map(({ pr }) => pr);
}

/** prsFor() for every session, by its id, leaving out those with none. */
export function prsBySession(sessions: readonly SessionSummary[], prs: readonly PullRequestSummary[]): Map<string, PullRequestSummary[]> {
  const bySession = new Map<string, PullRequestSummary[]>();
  if (prs.length === 0) return bySession;
  for (const session of sessions) {
    if (bySession.has(session.sessionId)) continue;
    const linked = prsFor(session, prs);
    if (linked.length > 0) bySession.set(session.sessionId, linked);
  }
  return bySession;
}

/** One of a PR's state badges (docs/design-system.md, 4: Pull requests). */
export interface PrStateBadge {
  /** Stable, for React and the tests. */
  state: 'failing' | 'conflicts' | 'changes-requested' | 'draft' | 'approved' | 'pending';
  label: string;
  look: BadgeLook;
  /** One of the three that make a PR need attention: highlighted. */
  attention: boolean;
}

/**
 * A PR's state badges, in the order they show: the highlighted ones, which make it need attention,
 * failing checks and conflicts in danger and changes requested in warning; then the quieter ones,
 * draft outlined, approved in success and checks pending in neutral. Passing checks, a clean merge, a
 * review that's still required and a mergeability GitHub is still working out get none in a row:
 * healthy and unknown states stay quiet. The PR view says each of them.
 */
export function prStateBadges(pr: PullRequestSummary): PrStateBadge[] {
  const badges: PrStateBadge[] = [];
  if (pr.checks === 'failing') badges.push({ state: 'failing', label: 'Checks failing', look: 'subtle-danger', attention: true });
  if (pr.mergeable === 'conflicts') badges.push({ state: 'conflicts', label: 'Conflicts', look: 'subtle-danger', attention: true });
  if (pr.review === 'changes-requested') badges.push({ state: 'changes-requested', label: 'Changes requested', look: 'subtle-warning', attention: true });
  if (pr.draft) badges.push({ state: 'draft', label: 'Draft', look: 'outline', attention: false });
  if (pr.review === 'approved') badges.push({ state: 'approved', label: 'Approved', look: 'subtle-success', attention: false });
  if (pr.checks === 'pending') badges.push({ state: 'pending', label: 'Checks pending', look: 'subtle-neutral', attention: false });
  return badges;
}

/** What the session row's PR badge shows: its most urgent strongly linked open PR, and how many more. */
export interface SessionPrBadge {
  pr: PullRequestSummary;
  more: number;
  attention: boolean;
  /** Its hover-only tooltip: each PR, by repo and number, its title, and its highlighted states. */
  hint: string;
}

/** The session row's PR badge, from prsFor()'s list, or undefined when it has none. */
export function sessionPrBadge(linked: readonly PullRequestSummary[] | undefined): SessionPrBadge | undefined {
  const [first] = linked ?? [];
  if (!linked || !first) return undefined;
  const line = (pr: PullRequestSummary) => {
    const states = prStateBadges(pr).filter((badge) => badge.attention);
    return `${prName(pr)}: ${plainText(pr.title)}${states.length > 0 ? ` (${states.map((badge) => badge.label.toLowerCase()).join(', ')})` : ''}`;
  };
  return { pr: first, more: linked.length - 1, attention: prNeedsAttention(first), hint: linked.map(line).join('\n') };
}

/** "1 open", "12 open", or "3 of 12 open" while the filter hides some. */
export function openCount(shown: number, total: number): string {
  return shown < total ? `${shown} of ${total} open` : `${total} open`;
}

/** "1 needs attention", "3 need attention". */
export function needAttention(count: number): string {
  return `${count} ${count === 1 ? 'needs' : 'need'} attention`;
}

/** Show older's label: "Show 17 older pull requests", or "Hide older pull requests" once they're listed. */
export const olderPrsText = (count: number, shown: boolean) =>
  shown ? 'Hide older pull requests' : `Show ${count} older ${count === 1 ? 'pull request' : 'pull requests'}`;

/** The line after it, which describes it. */
export const OLDER_PRS_NOTE = `Updated more than ${PRS_SHOWN_DAYS} days ago`;

/**
 * What the PR list's body shows (docs/design-system.md, 4: Pull requests, States):
 * - 'loading': no 'prs' message yet, or the first fetch hasn't finished and nothing has failed.
 * - 'off': `--no-prs`.
 * - 'failed': the latest fetch failed and none has worked yet, so there's no list: gh missing, gh not
 *   logged in, or anything else, each with how to fix it.
 * - 'list': a list, from the latest fetch, or, with `stale`, from the last one that worked, which
 *   the latest fetch couldn't replace.
 */
export type PrListState =
  | { kind: 'loading' }
  | { kind: 'off' }
  | { kind: 'failed'; reason: 'gh-missing' | 'gh-auth' | 'error'; error: string }
  | { kind: 'list'; fetchedAt: string; stale?: { reason: 'gh-missing' | 'gh-auth' | 'error'; error: string } };

export function prListState(list: PullRequestList | undefined): PrListState {
  if (!list) return { kind: 'loading' };
  const { source, fetchedAt } = list;
  if (source.ok) return fetchedAt === undefined ? { kind: 'loading' } : { kind: 'list', fetchedAt };
  const { reason, error } = source;
  if (reason === 'off') return { kind: 'off' };
  return fetchedAt === undefined ? { kind: 'failed', reason, error } : { kind: 'list', fetchedAt, stale: { reason, error } };
}
