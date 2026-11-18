// Why a row is in Needs you (W165), in one place for the page and the server. The page decides what
// goes in Needs you (`attention = own || prNeed`, SessionRow.tsx); the server's diagnostics log
// (src/server/diagnostics.ts) records the reason, and it must be the reason the page shows, so both
// call this code. Pure, and no text from a session or a PR: reasons are fixed words.
import { prNeedsAttention, prOwner, type NeedsYou, type PullRequestSummary, type SessionSummary } from './protocol.js';

/**
 * A session the index says needs Phil (SessionSummary.needsYou, W69), for one of NeedsYou's reasons,
 * judged from its context: a prompt on screen, a background job's own line on what it needs, a last
 * turn that asked him something, a restart he asked for, or blocked where pitwall couldn't read why.
 * `state: 'blocked'` alone isn't one. Never a stale or finished one, which the index never marks,
 * checked here too: a finished session's question still shows on its row, muted, but it isn't
 * counted anywhere. Nor an ended interactive session (W67), which is finished too, whatever it asked.
 *
 * Nor one you flagged as not needing you (W153, SessionSummary.flagged), which the server sets only
 * while it still needs what it needed when you flagged it, nor one you snoozed (W154,
 * SessionSummary.snoozed), which the server keeps until its time or a wake: Needs you, every need-you
 * count and the urgency sort leave them out. For what a row says it needs, whether the index says it
 * needs you, flagged or snoozed, is indexNeedsYou().
 */
export function needsAttention(session: SessionSummary): boolean {
  return indexNeedsYou(session) && session.flagged === undefined && session.snoozed === undefined;
}

/**
 * Whether the index says it needs you, whatever you flagged or snoozed: for what its row says it needs,
 * its badge's status, and the controls that hide it (W153's flag, W154's snooze). Never a stale,
 * finished or ended one.
 */
export function indexNeedsYou(session: SessionSummary): boolean {
  if (session.stale || session.finished || session.ended) return false;
  return session.needsYou !== undefined;
}

/**
 * Whether it's at work (W161): Claude Code says it's busy, or its running background job is working,
 * as quietWaitingOn() has it, and it hasn't finished or ended. Not when the transcript says its turn has
 * ended (turnEnded), since a plugin's monitor can keep the status at busy (spike 007, finding 6), nor when
 * it's stale, as a job blocked for days. A PR it owns doesn't put it in Needs you
 * while it is (prNeedOf()): it may be doing what the PR needs, and its own needs still do.
 */
export function isBusy(session: SessionSummary): boolean {
  if (session.finished || session.ended || session.stale === true || session.turnEnded === true) return false;
  return session.status === 'busy' || (session.alive && session.state === 'working');
}

const time = (iso: string) => {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? 0 : at;
};

/** The most urgent first: the PRs that need attention, then the newest updated, then the highest number. */
export function comparePrs(a: PullRequestSummary, b: PullRequestSummary): number {
  const attention = Number(prNeedsAttention(b)) - Number(prNeedsAttention(a));
  if (attention !== 0) return attention;
  return time(b.updatedAt) - time(a.updatedAt) || b.number - a.number;
}

/**
 * The most urgent of `owned` (most urgent first, comparePrs()) that needs attention, or undefined
 * while the session is busy (W161, isBusy()): Phil, 2026-11-06, saw a session at work on the PR that
 * asks his review listed in Needs you for that review, which said nothing of what the session needed.
 */
export function prNeedOf(session: SessionSummary, owned: readonly PullRequestSummary[] | undefined): PullRequestSummary | undefined {
  return isBusy(session) ? undefined : owned?.find(prNeedsAttention);
}

/** The open PRs each session owns (prOwner()), by session id, most urgent first. Only sessions that own one. */
export function ownedPrsBySession(sessions: readonly SessionSummary[], prs: readonly PullRequestSummary[]): Map<string, PullRequestSummary[]> {
  const owned = new Map<string, PullRequestSummary[]>();
  // Only sessions with a strong link can own one, and few have any: the rest are left out of each search.
  const linked = sessions.filter((session) => session.prLinks !== undefined && session.prLinks.some((link) => link.kind !== 'mentioned'));
  if (linked.length === 0) return owned;
  for (const pr of [...prs].sort(comparePrs)) {
    const owner = prOwner(pr, linked);
    if (owner !== undefined) owned.set(owner.sessionId, [...(owned.get(owner.sessionId) ?? []), pr]);
  }
  return owned;
}

/** Why a PR needs you, as a fixed word (prNeedsAttention()). */
export type PrNeedKind = 'review-requested' | 'checks-failing' | 'conflicts' | 'changes-requested';

/** The PR's reason for needing you, or undefined when it doesn't. The first that holds, in prNeedsAttention()'s order. */
export function prNeedKind(pr: PullRequestSummary): PrNeedKind | undefined {
  if (!prNeedsAttention(pr)) return undefined;
  if (pr.relation === 'review-requested') return 'review-requested';
  if (pr.checks === 'failing') return 'checks-failing';
  if (pr.mergeable === 'conflicts') return 'conflicts';
  return 'changes-requested';
}

/** Why a session's row is in Needs you, or that it isn't. All fixed words and IDs. */
export interface NeedsYouReason {
  /** The row is in Needs you: `own || prNeed`, as the page decides. */
  attention: boolean;
  /** The session's own reason, while it needs you itself (needsAttention()). */
  own?: NeedsYou['reason'];
  /** The index says it needs you, but a flag or a snooze has set it aside, so it isn't `own`. */
  setAside?: 'flagged' | 'snoozed';
  /** The PR that puts it here while it isn't busy: why, the PR as `owner/repo#123`, and how a review was asked. */
  pr?: { need: PrNeedKind; ref: string; via?: 'direct' | 'team' };
  /** Which one the row's second line explains when both hold: the session's own, else the PR's. */
  won?: 'own' | 'pr';
}

/** Why `session`'s row is in Needs you, given the PRs it owns (ownedPrsBySession()), by the page's own rules. */
export function needsYouReason(session: SessionSummary, owned: readonly PullRequestSummary[] | undefined): NeedsYouReason {
  const own = needsAttention(session);
  const pr = prNeedOf(session, owned);
  const reason: NeedsYouReason = { attention: own || pr !== undefined };
  if (own && session.needsYou !== undefined) reason.own = session.needsYou.reason;
  else if (indexNeedsYou(session)) reason.setAside = session.flagged !== undefined ? 'flagged' : 'snoozed';
  if (pr !== undefined) {
    const need = prNeedKind(pr);
    if (need !== undefined) {
      reason.pr = { need, ref: `${pr.repo}#${pr.number}`, ...(pr.reviewRequest?.via === undefined ? {} : { via: pr.reviewRequest.via }) };
    }
  }
  if (reason.own !== undefined) reason.won = 'own';
  else if (reason.pr !== undefined) reason.won = 'pr';
  return reason;
}
