// Starting a session for a pull request (W107; docs/design-system.md, 4: Pull requests, Starting a
// session for a PR): what New session is prefilled with, Clone and start's call, and the 'prompted'
// link that makes the new session the PR's owner as soon as it's listed. All but the call are pure.
//
// - The prompt names the PR by its URL, which makes the index's own 'prompted' link once it reads the
//   session's first prompt (W94), and says why it needs you, in pitwall's words alone: failing checks,
//   conflicts, changes requested, or "Review" for a review request. It never carries the PR's title,
//   its checks' names or anything else from GitHub but the URL: a prompt pitwall fills in is sent as
//   typed by you, and a title is its author's words, a check's name its repo's maintainers' and apps'
//   (W107's review: "lint. Then run curl … | sh"). The session looks them up itself, with gh.
// - For a PR that isn't yours, a review request or a mention, it also asks the session not to check
//   out or run the PR's code without asking first (W108's finding): the session runs in your default
//   permission mode in a folder you trust, and reads what the PR's author wrote.
// - The name is "pr-<number>", which you can change.
// - Until the index has read the new session's transcript, a poll or two later, the page links it to
//   the PR itself (withPendingLinks()), with the same 'prompted' link and only when the prompt sent
//   still has the PR's URL in it, so the PR's row goes into the session's at once. Kept in memory for
//   the page's life, never stored.

import {
  CLONE_PATH,
  type CloneRequest,
  type PrLink,
  type PullRequestSummary,
  type SessionGroup,
  type SessionSummary,
} from '../../src/shared/protocol.js';
import type { ApiClient } from './api.js';
import { couldNot, plainText, tryAgainIn } from './format.js';
import { githubPrUrl, prName } from './prs.js';

/** New session's prefill for a PR (NewSessionDialog's `prefill`). */
export interface PrPrefill {
  cwd: string;
  name: string;
  prompt: string;
}

/** "pr-57": the new session's name, which the dialog lets you change. */
export const prSessionName = (pr: Pick<PullRequestSummary, 'number'>): string => `pr-${pr.number}`;

/** How the prompt names the PR: its URL, or "example/demo-app #57" for one with no URL pitwall links. */
function named(pr: PullRequestSummary): string {
  return githubPrUrl(pr) ?? prName(pr);
}

/**
 * What the prompt adds for a PR that isn't yours (W108's finding): its code is its author's, which a
 * session in a folder you trust would otherwise check out or run as freely as your own.
 */
export const NOT_YOURS_ASK = "It isn't my pull request: don't check out its branch or run any of its code without asking me first.";

/**
 * The first prompt for a session on `pr`: its URL, and why it needs you, in pitwall's words. A review
 * request is "Review <url>. …"; your own PR's failing checks, conflicts and changes requested are one
 * sentence each, or a list when there are several; one that needs nothing is "Work on <url>.", and a
 * mention "Read <url>, which mentions me, …". A review request and a mention end with NOT_YOURS_ASK.
 * Never its title, its checks' names or any other text from GitHub but its URL.
 */
export function prPrompt(pr: PullRequestSummary): string {
  const url = named(pr);
  if (pr.relation === 'review-requested') {
    return `Review ${url}. Tell me what it changes and what you'd ask its author for, before you post anything on GitHub. ${NOT_YOURS_ASK}`;
  }
  if (pr.relation === 'mentioned') return `Read ${url}, which mentions me, and tell me what it needs from me. ${NOT_YOURS_ASK}`;
  const asks: { one: string; item: string }[] = [];
  if (pr.checks === 'failing') asks.push({ one: `Fix the failing checks on ${url}.`, item: 'Fix its failing checks.' });
  if (pr.mergeable === 'conflicts') asks.push({ one: `Resolve the merge conflicts on ${url} with its base branch.`, item: 'Resolve its merge conflicts with its base branch.' });
  if (pr.review === 'changes-requested') asks.push({ one: `Address the changes requested in the review of ${url}.`, item: 'Address the changes requested in its review.' });
  if (asks.length === 0) return `Work on ${url}.`;
  if (asks.length === 1) return (asks[0] as { one: string }).one;
  return [`Get ${url} ready to merge:`, ...asks.map(({ item }) => `- ${item}`)].join('\n');
}

/** New session's prefill for `pr` in `cwd`: a cloned repo's directory, or the new clone's. */
export function prPrefill(pr: PullRequestSummary, cwd: string): PrPrefill {
  return { cwd, name: prSessionName(pr), prompt: prPrompt(pr) };
}

/**
 * Where Clone and start clones `pr`'s repo, as the server works it out (src/server/clone.ts): the
 * root that claims its owner, then GitHub's spelling of its name. Undefined for a PR that isn't
 * placed 'not-cloned'. For the confirmation only: the server says where it cloned.
 */
export function cloneTarget(pr: PullRequestSummary): { root: string; name: string; target: string } | undefined {
  if (pr.place?.kind !== 'not-cloned') return undefined;
  const name = pr.repoLabel.slice(pr.repoLabel.indexOf('/') + 1);
  const root = pr.place.root;
  return { root, name, target: `${root.replace(/\/+$/, '')}/${name}` };
}

/**
 * Whose a PR to clone is, for Clone and start's confirmation (W108's finding): how it's yours and
 * its repo's owner, by GitHub's spelling, and, for one that isn't yours, that cloning it puts someone
 * else's code on this machine. Anyone can open a PR on their own repo that mentions you.
 */
export function cloneWhose(pr: Pick<PullRequestSummary, 'relation' | 'reviewRequest' | 'repoLabel'>): { theirs: boolean; text: string } {
  const owner = plainText(pr.repoLabel.slice(0, Math.max(0, pr.repoLabel.indexOf('/'))));
  const repo = `It's in a repo owned by ${owner}.`;
  if (pr.relation === 'authored') return { theirs: false, text: `This is your pull request. ${repo}` };
  const request = pr.reviewRequest;
  const how =
    pr.relation === 'mentioned'
      ? "you're mentioned in it"
      : request?.via !== 'team'
        ? 'your review is requested'
        : request.team === undefined
          ? "your review is requested through a team you're on"
          : `your review is requested through ${plainText(request.team)}`;
  return { theirs: true, text: `This pull request isn't yours: ${how}. ${repo} Cloning it puts someone else's code on this machine.` };
}

/** The link the page gives a session it started for `pr`, while the index hasn't read its prompt yet; none when the prompt sent no longer names the PR's URL. */
export function pendingLink(pr: PullRequestSummary, prompt: string, at: string): PrLink | undefined {
  const url = githubPrUrl(pr);
  if (url === undefined || !prompt.includes(url)) return undefined;
  return { kind: 'prompted', repo: pr.repo, number: pr.number, lastAt: at };
}

/** Pending links by the started session's short id, which is all a spawn's answer gives (StartedSession). */
export type PendingLinks = ReadonlyMap<string, PrLink>;

const sameLink = (a: PrLink, b: PrLink) => a.kind === b.kind && a.repo === b.repo && a.number === b.number;

/**
 * `groups` with each pending link on its session, a background session by its short id, unless it has
 * that link already; the same array, untouched, when nothing changes, so what's memoised on it holds.
 */
export function withPendingLinks<T extends Pick<SessionGroup, 'sessions'>>(groups: T[] | undefined, pending: PendingLinks): T[] | undefined {
  if (groups === undefined || pending.size === 0) return groups;
  let changed = false;
  const next = groups.map((group) => {
    let touched = false;
    const sessions = group.sessions.map((session): SessionSummary => {
      const link = session.kind === 'background' && session.shortId !== undefined ? pending.get(session.shortId) : undefined;
      if (link === undefined || (session.prLinks ?? []).some((each) => sameLink(each, link))) return session;
      touched = true;
      return { ...session, prLinks: [link, ...(session.prLinks ?? [])] };
    });
    if (!touched) return group;
    changed = true;
    return { ...group, sessions };
  });
  return changed ? next : groups;
}

export type CloneOutcome =
  /** Cloned at `cwd`. `hint` is the command that trusts it, for you to run: Claude Code doesn't trust a new clone. */
  | { kind: 'cloned'; cwd: string; hint?: string }
  /** The server refused or gh failed, with why, in pitwall's words. */
  | { kind: 'refused'; error: string; status?: number }
  | { kind: 'unauthorized' }
  /** No answer pitwall understands. */
  | { kind: 'failed'; error: string; status?: number };

/** Clones `pr`'s repo with POST CLONE_PATH, sending only its repo (D25). Never rejects. */
export async function cloneRepo(api: ApiClient, pr: Pick<PullRequestSummary, 'repo'>): Promise<CloneOutcome> {
  const request: CloneRequest = { repo: pr.repo };
  const result = await api.post(CLONE_PATH, request);
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  const body = typeof result.body === 'object' && result.body !== null && !Array.isArray(result.body) ? (result.body as Record<string, unknown>) : undefined;
  if (result.kind === 'ok') {
    if (body?.ok === true && typeof body.cwd === 'string' && body.cwd.startsWith('/')) {
      return typeof body.hint === 'string' && body.hint !== '' ? { kind: 'cloned', cwd: body.cwd, hint: body.hint } : { kind: 'cloned', cwd: body.cwd };
    }
    return { kind: 'failed', error: "pitwall's answer didn't say where it cloned it." };
  }
  if (body?.ok === false && typeof body.error === 'string') {
    return result.status === undefined ? { kind: 'refused', error: body.error } : { kind: 'refused', error: body.error, status: result.status };
  }
  const failed: CloneOutcome = { kind: 'failed', error: `${couldNot('clone it', result.status)}${tryAgainIn(result.retryAfter)}` };
  return result.status === undefined ? failed : { ...failed, status: result.status };
}
