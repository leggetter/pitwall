// Your open pull requests in the web UI (M4, W95; docs/design-system.md, 4: Pull requests): reading
// the 'prs' message defensively, where the server placed each one and which owners each root claims
// (W106), and what the screen derives from one PR: the sessions linked to it, the 90-day window, the
// filter and its chips, the attention count, the state badges, how a PR is yours (W101), why it needs
// you, and the PR's link. All pure, so they're easy to test. Which session owns a PR, and where a PR
// with none is listed, is work.ts's (W106).
//
// The index finds each session's links without knowing which PRs are open (SessionSummary.prLinks),
// and the page matches them against the list with prLinkMatches() (src/shared/protocol.ts), so a link
// to a PR that isn't one of your open ones shows nothing. Every kind but mentioned is strong, and only
// a strong link can make a session a PR's owner (prOwner()). A mentioned one, Claude naming the PR in
// a reply, shows only in the PR view, under Mentioned in.

import {
  GITHUB_OWNER_PATTERN,
  GITHUB_REPO_NAME_PATTERN,
  PR_FAILING_CHECKS_MAX,
  PR_RELATIONS,
  PR_TITLE_MAX,
  prLinkIsStrong,
  prLinkMatches,
  prNeedsAttention,
  PRS_LIST_MAX,
  PRS_SHOWN_DAYS,
  type PrLink,
  type PullRequestChecks,
  type PullRequestList,
  type PullRequestMergeable,
  type PullRequestPlace,
  type PullRequestRelation,
  type PullRequestReview,
  type PullRequestReviewRequest,
  type PullRequestSearchState,
  type PullRequestSource,
  type PullRequestSummary,
  type RootOwners,
  type SessionSummary,
} from '../../src/shared/protocol.js';
import { plainText } from './format.js';
import type { BadgeLook } from './sessions.js';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isTime = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && !Number.isNaN(Date.parse(value));

/** An `owner/name` as the contract's patterns allow them, in any case (GITHUB_OWNER_PATTERN), as W93's reader does. */
const OWNER_NAME = new RegExp(`^(${GITHUB_OWNER_PATTERN})/(${GITHUB_REPO_NAME_PATTERN})$`);

/** A PR's own address on github.com, and nothing more: no query, no fragment, no other host. */
const GITHUB_PR_URL = new RegExp(`^https://github\\.com/(${GITHUB_OWNER_PATTERN})/(${GITHUB_REPO_NAME_PATTERN})/pull/([1-9][0-9]{0,9})$`);

/**
 * Whether `value` is a lowercase `owner/name`, what PullRequestSummary.repo and PrLink.repo hold:
 * an Enterprise Managed User's `name_shortcode` too, and never `.` or `..` as the name.
 */
export function isRepoKey(value: string): boolean {
  const match = OWNER_NAME.exec(value);
  return match !== null && value === value.toLowerCase() && match[2] !== '.' && match[2] !== '..';
}

/** The most characters of a check's name that the page keeps. */
const NAME_MAX = 200;

/** The longest head branch the contract keeps: a longer one, as an empty one, means no head (PullRequestSummary.head). */
const BRANCH_MAX = 255;

/** C0 and C1 controls and the bidi controls, which a head branch never has (PullRequestSummary.head). */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

/** A team's `org/slug`, as PullRequestReviewRequest.team holds it. */
const TEAM = new RegExp(`^(${GITHUB_OWNER_PATTERN})/(${GITHUB_REPO_NAME_PATTERN})$`);

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
  if (name === '.' || name === '..') return undefined;
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

/** The longest root, repo key or label a place may name: a path, as the snapshot's are. */
const PATH_MAX = 4096;

const isPath = (value: unknown): value is string => typeof value === 'string' && value !== '' && value.length <= PATH_MAX;

/**
 * Where the server placed a PR with no owning session (W104, W106), or undefined when it isn't the
 * contract's shape, which the page treats as 'unclaimed', as it does a server that doesn't place PRs.
 */
export function parsePlace(value: unknown): PullRequestPlace | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === 'unclaimed') return { kind: 'unclaimed' };
  if (value.kind === 'not-cloned') return isPath(value.root) ? { kind: 'not-cloned', root: value.root } : undefined;
  if (value.kind !== 'cloned' || !isPath(value.root) || !isPath(value.key) || !isPath(value.label)) return undefined;
  return { kind: 'cloned', root: value.root, key: value.key, label: value.label };
}

/** A lowercase GitHub owner, as RootOwners.owners holds them. */
const OWNER = new RegExp(`^(${GITHUB_OWNER_PATTERN})$`);

/** The most roots, and owners of one root, the page keeps from a list: far more than anyone configures. */
const ROOTS_MAX = 64;
const OWNERS_MAX = 500;

/** Which owners each root claims (W104, W106), read defensively: an entry that isn't the shape is left out, and so is an owner that isn't one. */
export function parseRootOwners(value: unknown): RootOwners[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const roots: RootOwners[] = [];
  for (const each of value.slice(0, ROOTS_MAX)) {
    if (!isRecord(each) || !isPath(each.root) || (each.source !== 'config' && each.source !== 'clones')) continue;
    const { owners } = each;
    if (owners === 'all' || owners === 'none') roots.push({ root: each.root, owners, source: each.source });
    else if (Array.isArray(owners)) {
      const kept = owners.filter((owner): owner is string => typeof owner === 'string' && OWNER.test(owner) && owner === owner.toLowerCase()).slice(0, OWNERS_MAX);
      roots.push({ root: each.root, owners: [...new Set(kept)], source: each.source });
    }
  }
  return roots;
}

/** One PR from the 'prs' message, or undefined when it isn't the contract's shape. */
export function parsePullRequest(value: unknown): PullRequestSummary | undefined {
  if (!isRecord(value)) return undefined;
  const { url, repo, repoLabel, number, title, draft, createdAt, updatedAt, head, checks, failingChecks, failingCount, review, mergeable, relation, reviewRequest, place } = value;
  if (typeof repo !== 'string' || !isRepoKey(repo)) return undefined;
  if (typeof repoLabel !== 'string' || repoLabel.toLowerCase() !== repo) return undefined;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) return undefined;
  if (typeof url !== 'string' || githubPrUrl({ url, repo, number }) === undefined) return undefined;
  if (typeof title !== 'string' || typeof draft !== 'boolean' || !isTime(createdAt) || !isTime(updatedAt)) return undefined;
  if (!(CHECKS as readonly unknown[]).includes(checks) || !(MERGEABLE as readonly unknown[]).includes(mergeable)) return undefined;
  if (review !== undefined && !(REVIEWS as readonly unknown[]).includes(review)) return undefined;
  // How it's yours decides whether it needs you, so one this page doesn't know is left out.
  if (!(PR_RELATIONS as readonly unknown[]).includes(relation)) return undefined;
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
    relation: relation as PullRequestRelation,
  };
  // A head that isn't the contract's shape is left out, as the server leaves out one whose repo has
  // gone, or whose branch is empty, over 255 characters, or has a control or bidi control character.
  if (isRecord(head) && typeof head.repo === 'string' && isRepoKey(head.repo) && typeof head.branch === 'string') {
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
  if (pr.relation === 'review-requested') {
    const request = parseReviewRequest(reviewRequest);
    if (request) pr.reviewRequest = request;
  }
  const placed = parsePlace(place);
  if (placed) pr.place = placed;
  return pr;
}

/**
 * How a review was requested (W101), or undefined when it isn't the contract's shape. A team's name
 * that isn't an `org/slug` is left out, and the request kept, as one of a team pitwall can't name.
 */
function parseReviewRequest(value: unknown): PullRequestReviewRequest | undefined {
  if (!isRecord(value)) return undefined;
  if (value.via === 'direct') return { via: 'direct' };
  if (value.via !== 'team') return undefined;
  const { team } = value;
  const match = typeof team === 'string' ? TEAM.exec(team) : null;
  return match && match[2] !== '.' && match[2] !== '..' ? { via: 'team', team: team as string } : { via: 'team' };
}

/** A failure's reasons, without 'off', which is the whole list's, never one search's. */
const SEARCH_REASONS = ['gh-missing', 'gh-auth', 'error'] as const;

/**
 * Each search's part of the list (W101), read defensively: a relation this page doesn't know is left
 * out, and so is a time that isn't one; a reason it doesn't know is an error.
 */
function parseSearches(value: unknown): Partial<Record<PullRequestRelation, PullRequestSearchState>> | undefined {
  if (!isRecord(value)) return undefined;
  const searches: Partial<Record<PullRequestRelation, PullRequestSearchState>> = {};
  for (const relation of PR_RELATIONS) {
    const each = Object.hasOwn(value, relation) ? value[relation] : undefined;
    if (!isRecord(each)) continue;
    const state: PullRequestSearchState = {};
    if (isTime(each.fetchedAt)) state.fetchedAt = each.fetchedAt;
    const { failed } = each;
    if (isRecord(failed) && typeof failed.error === 'string') {
      const reason = (SEARCH_REASONS as readonly unknown[]).includes(failed.reason) ? (failed.reason as (typeof SEARCH_REASONS)[number]) : 'error';
      state.failed = { reason, error: failed.error.slice(0, 500) };
    }
    searches[relation] = state;
  }
  return searches;
}

/**
 * The 'prs' message's list, or undefined when it isn't the contract's shape: no source, no
 * `refreshing`, or `prs` that isn't a list. A PR in it that isn't the contract's shape is left out,
 * and so is a second one with the same repo and number; at most PRS_LIST_MAX are kept.
 */
export function parsePullRequestList(value: unknown): PullRequestList | undefined {
  if (!isRecord(value)) return undefined;
  const source = parseSource(value.source);
  if (!source || typeof value.refreshing !== 'boolean' || !Array.isArray(value.prs)) return undefined;
  const seen = new Set<string>();
  const prs: PullRequestSummary[] = [];
  for (const each of value.prs) {
    if (prs.length >= PRS_LIST_MAX) break;
    const pr = parsePullRequest(each);
    if (!pr || seen.has(prKey(pr))) continue;
    seen.add(prKey(pr));
    prs.push(pr);
  }
  const list: PullRequestList = { source, refreshing: value.refreshing, prs };
  if (isTime(value.fetchedAt)) list.fetchedAt = value.fetchedAt;
  const searches = parseSearches(value.searches);
  if (searches) list.searches = searches;
  if (value.truncated === true) list.truncated = true;
  const roots = parseRootOwners(value.roots);
  if (roots) list.roots = roots;
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

/**
 * How many of `prs` need you (prNeedsAttention()): your own with failing checks, conflicts or changes
 * requested, and those whose review is requested of you (W101).
 */
export function countPrAttention(prs: readonly PullRequestSummary[]): number {
  return prs.reduce((count, pr) => count + (prNeedsAttention(pr) ? 1 : 0), 0);
}

const time = (iso: string) => {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? 0 : at;
};

/** When a PR was last updated, in ms; 0 when that doesn't parse. */
export const prUpdatedMs = (pr: Pick<PullRequestSummary, 'updatedAt'>): number => time(pr.updatedAt);

/** The most urgent first: the PRs that need attention, then the newest updated, then the highest number. */
export function comparePrs(a: PullRequestSummary, b: PullRequestSummary): number {
  const attention = Number(prNeedsAttention(b)) - Number(prNeedsAttention(a));
  if (attention !== 0) return attention;
  return time(b.updatedAt) - time(a.updatedAt) || b.number - a.number;
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

/**
 * The PR list's chips (W101): Yours, Review requested and Mentioned, in PR_RELATIONS' order. They
 * combine as OR, as the session list's do: none on is All, either one alone narrows the list, and all
 * three together show every PR.
 */
export const RELATION_CHIPS: Readonly<Record<PullRequestRelation, string>> = {
  authored: 'Yours',
  'review-requested': 'Review requested',
  mentioned: 'Mentioned',
};

/** The PRs of the relations on, in the order given; with none on, every one. */
export function filterPrsByRelation(prs: readonly PullRequestSummary[], relations: ReadonlySet<PullRequestRelation>): PullRequestSummary[] {
  return relations.size === 0 ? [...prs] : prs.filter((pr) => relations.has(pr.relation));
}

/**
 * What each search finds, as the PR list's notice and empty states name it when that search fails
 * (W101): "Your own pull requests", "The pull requests that ask your review", "The pull requests
 * that mention you".
 */
export const SEARCH_NAMES: Readonly<Record<PullRequestRelation, string>> = {
  authored: 'Your own pull requests',
  'review-requested': 'The pull requests that ask your review',
  mentioned: 'The pull requests that mention you',
};

/**
 * How the PR is yours, in a sentence, for the PR view (W101), or undefined for one you opened, which
 * needs none: "Your review is requested." with the team when it was a team's and pitwall can name
 * it, "Your review is requested through a team you're on." when it can't, and "You're mentioned in
 * it." for a mention.
 */
export function prRelationText(pr: Pick<PullRequestSummary, 'relation' | 'reviewRequest'>): string | undefined {
  if (pr.relation === 'mentioned') return "You're mentioned in it.";
  if (pr.relation !== 'review-requested') return undefined;
  const request = pr.reviewRequest;
  if (request?.via !== 'team') return 'Your review is requested.';
  return request.team === undefined ? "Your review is requested through a team you're on." : `Your review is requested through ${plainText(request.team)}.`;
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
 * The open PRs a session is strongly linked to (prLinkIsStrong()), whether or not it owns them, most
 * urgent first (comparePrs()): its view's Pull requests tab lists the ones it doesn't own after the
 * ones it does (W106).
 */
export function strongPrsOf(session: SessionSummary, prs: readonly PullRequestSummary[]): PullRequestSummary[] {
  if (!session.prLinks?.some(prLinkIsStrong)) return [];
  return prs.filter((pr) => linksTo(session, pr).some(prLinkIsStrong)).sort(comparePrs);
}

/** One of a PR's state badges (docs/design-system.md, 4: Pull requests). */
export interface PrStateBadge {
  /** Stable, for React and the tests. */
  state: 'review-requested' | 'mentioned' | 'failing' | 'conflicts' | 'changes-requested' | 'draft' | 'approved' | 'pending';
  label: string;
  look: BadgeLook;
  /** One of those that make a PR need attention: highlighted. */
  attention: boolean;
  /** Its hover-only tooltip, when it has more to say: who a review was asked of. */
  hint?: string;
}

/**
 * A PR's state badges, in the order they show. First, how it's yours when you didn't open it (W101):
 * Review requested in warning, which needs you, as a session that asked you is; Mentioned in
 * neutral, which doesn't. Then the highlighted ones, which make your own PR need attention, failing
 * checks and conflicts in danger and changes requested in warning; on another author's PR they keep
 * their looks, but they're theirs to fix, so they don't make it need attention. Then the quieter
 * ones, draft outlined, approved in success and checks pending in neutral. Passing checks, a clean
 * merge, a review that's still required and a mergeability GitHub is still working out get none in a
 * row: healthy and unknown states stay quiet. The PR view says each of them.
 */
export function prStateBadges(pr: PullRequestSummary): PrStateBadge[] {
  const badges: PrStateBadge[] = [];
  if (pr.relation === 'review-requested') {
    const badge: PrStateBadge = { state: 'review-requested', label: 'Review requested', look: 'subtle-warning', attention: true };
    const hint = prRelationText(pr);
    if (pr.reviewRequest?.via === 'team' && hint) badge.hint = hint;
    badges.push(badge);
  }
  if (pr.relation === 'mentioned') badges.push({ state: 'mentioned', label: 'Mentioned', look: 'subtle-neutral', attention: false });
  const yours = pr.relation === 'authored';
  if (pr.checks === 'failing') badges.push({ state: 'failing', label: 'Checks failing', look: 'subtle-danger', attention: yours });
  if (pr.mergeable === 'conflicts') badges.push({ state: 'conflicts', label: 'Conflicts', look: 'subtle-danger', attention: yours });
  if (pr.review === 'changes-requested') badges.push({ state: 'changes-requested', label: 'Changes requested', look: 'subtle-warning', attention: yours });
  if (pr.draft) badges.push({ state: 'draft', label: 'Draft', look: 'outline', attention: false });
  if (pr.review === 'approved') badges.push({ state: 'approved', label: 'Approved', look: 'subtle-success', attention: false });
  if (pr.checks === 'pending') badges.push({ state: 'pending', label: 'Checks pending', look: 'subtle-neutral', attention: false });
  return badges;
}

/**
 * The session row's PR badge's state (W106): the most urgent of the PR's highlighted states, short,
 * after its number, "#128 CI failing", or undefined for one that needs nothing.
 */
const BADGE_STATES: Readonly<Partial<Record<PrStateBadge['state'], string>>> = {
  'review-requested': 'review requested',
  failing: 'CI failing',
  conflicts: 'conflicts',
  'changes-requested': 'changes requested',
};

/** What the session row's PR badge shows: the most urgent open PR the session owns, its state, and how many more it owns. */
export interface SessionPrBadge {
  pr: PullRequestSummary;
  /** Its most urgent highlighted state, short: "CI failing", "conflicts". None for a PR that needs nothing. */
  state?: string;
  more: number;
  attention: boolean;
  /** Its hover-only tooltip: each PR, by repo and number, its title, and its highlighted states. */
  hint: string;
}

/**
 * The session row's PR badge, from the PRs it owns (work.ts), most urgent first, or undefined when it
 * owns none (W106). A session strongly linked to a PR that another session owns has no badge for it.
 */
export function sessionPrBadge(owned: readonly PullRequestSummary[] | undefined): SessionPrBadge | undefined {
  const [first] = owned ?? [];
  if (!owned || !first) return undefined;
  const line = (pr: PullRequestSummary) => {
    const states = prStateBadges(pr).filter((badge) => badge.attention);
    return `${prName(pr)}: ${plainText(pr.title)}${states.length > 0 ? ` (${states.map((badge) => badge.label.toLowerCase()).join(', ')})` : ''}`;
  };
  const urgent = prStateBadges(first).find((badge) => badge.attention && prNeedsAttention(first));
  const state = urgent === undefined ? undefined : BADGE_STATES[urgent.state];
  return { pr: first, ...(state === undefined ? {} : { state }), more: owned.length - 1, attention: prNeedsAttention(first), hint: owned.map(line).join('\n') };
}

/**
 * Why a PR needs you, in a sentence, for line 2 of a row (W106), or undefined when it doesn't
 * (prNeedsAttention()): "Your review is requested", "CI is failing", "It has merge conflicts" or
 * "Changes are requested", in that order, as its badges are. With `number`, it names the PR, as a
 * session row's line 2 does: "CI is failing on #128".
 */
export function prReason(pr: PullRequestSummary, number = false): string | undefined {
  if (!prNeedsAttention(pr)) return undefined;
  const on = number ? ` on #${pr.number}` : '';
  if (pr.relation === 'review-requested') return `Your review is requested${on}`;
  if (pr.checks === 'failing') return `CI is failing${on}`;
  if (pr.mergeable === 'conflicts') return number ? `#${pr.number} has merge conflicts` : 'It has merge conflicts';
  if (pr.review === 'changes-requested') return `Changes are requested${on}`;
  return undefined;
}

/** How a PR is yours, in a word or two, for a PR row's line 2 while it needs nothing (W106): "Yours", "Mentions you". */
export const RELATION_PHRASES: Readonly<Record<PullRequestRelation, string>> = {
  authored: 'Yours',
  'review-requested': 'Asks your review',
  mentioned: 'Mentions you',
};

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

/** A search whose latest try failed while another worked (W101): why, and when its PRs are from, if it ever worked. */
export interface PrSearchFailure {
  relation: PullRequestRelation;
  reason: 'gh-missing' | 'gh-auth' | 'error';
  error: string;
  fetchedAt?: string;
}

/**
 * What the PR list's body shows (docs/design-system.md, 4: Pull requests, States):
 * - 'loading': no 'prs' message yet, or the first fetch hasn't finished and nothing has failed.
 * - 'off': `--no-prs`.
 * - 'failed': the latest fetch failed and none has worked yet, so there's no list: gh missing, gh not
 *   logged in, or anything else, each with how to fix it.
 * - 'list': a list, from the latest fetch, or, with `stale`, from the last one that worked, which
 *   the latest fetch couldn't replace. With `failed`, the latest fetch worked for some searches and
 *   not others (W101): each failed one's PRs are its last good ones, from its own fetchedAt.
 */
export type PrListState =
  | { kind: 'loading' }
  | { kind: 'off' }
  | { kind: 'failed'; reason: 'gh-missing' | 'gh-auth' | 'error'; error: string }
  | { kind: 'list'; fetchedAt: string; stale?: { reason: 'gh-missing' | 'gh-auth' | 'error'; error: string }; failed?: PrSearchFailure[] };

export function prListState(list: PullRequestList | undefined): PrListState {
  if (!list) return { kind: 'loading' };
  const { source, fetchedAt } = list;
  if (source.ok) {
    if (fetchedAt === undefined) return { kind: 'loading' };
    const failed = PR_RELATIONS.flatMap((relation): PrSearchFailure[] => {
      const each = list.searches?.[relation];
      if (!each?.failed) return [];
      return [{ relation, ...each.failed, ...(each.fetchedAt === undefined ? {} : { fetchedAt: each.fetchedAt }) }];
    });
    return failed.length > 0 ? { kind: 'list', fetchedAt, failed } : { kind: 'list', fetchedAt };
  }
  const { reason, error } = source;
  if (reason === 'off') return { kind: 'off' };
  return fetchedAt === undefined ? { kind: 'failed', reason, error } : { kind: 'list', fetchedAt, stale: { reason, error } };
}
