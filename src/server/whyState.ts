// Why a session is in the state its row shows (W178): each badge it has, the rule that set it and the
// inputs the rule read, for the supervisor's why_state tool (mcpTools.ts). Every verdict comes from the
// code the page uses (src/shared/sessionState.ts and needsYou.ts), never a copy of its rules, so the two
// can't disagree; mcpTools.test.ts' "why_state (W178)" tests check that for each status. Pure. Everything in the
// answer is pitwall's own fixed words, ids, enums, numbers and times, except what is under `untrusted`
// (a prompt's reason, a job's line, a PR's repo): text from sessions or GitHub, plain and capped by the caller.
import { CONTEXT_HIGH_TOKENS, CONTEXT_WARN_TOKENS, type PullRequestSummary, type SessionSummary } from '../shared/protocol.js';
import { indexNeedsYou, isBusy, needsYouReason, ownedPrsBySession, prNeedKind } from '../shared/needsYou.js';
import { contextLevel, isFlagged, isHandedOff, isSnoozed, NEEDS_YOU_RULES, PR_NEED_RULES, snoozeBack, statusBadge, STATUS_RULES } from '../shared/sessionState.js';

/** The rule behind isBusy(), in words. */
export const BUSY_RULE =
  "At work when Claude Code says busy, or its running background job is working, and it hasn't finished, ended, gone stale or ended its turn (turnEnded). A PR it owns doesn't put it in Needs you while it is busy.";

/** What flag and snooze do to Needs you, in words. */
export const SET_ASIDE_RULE =
  "A flag (you said it doesn't need you, kept only while it needs what it needed then) or a snooze (until a time, or Later until woken, holding the PRs the session owned that needed you then until one has something new) takes a session the index says needs you out of Needs you and the counts. Its badge keeps its text, outlined.";

/** The explanation of one session: the answer's JSON, apart from `untrusted`, which the caller fills with capped text. */
export interface StateExplanation {
  status: { status: string; label: string; look: string; dot?: true; setAside?: true; rule: string };
  busy: { busy: boolean; rule: string };
  needsYou: {
    /** The row is in Needs you: its own need or a PR's, as the page decides. */
    inNeedsYou: boolean;
    /** The index says it needs you (before any flag or snooze). */
    indexSaysNeeds: boolean;
    own?: { reason: string; rule: string };
    setAside?: 'flagged' | 'snoozed';
    pr?: { need: string; rule: string; via?: 'direct' | 'team' };
    /** The PR needs you but the session is busy, so it isn't counted (W161). */
    prHeldWhileBusy?: { need: string };
    /** Which one line 2 explains when both hold. */
    won?: 'own' | 'pr';
    /**
     * W210: its hand-off's card (Clear and continue) is in Needs you and counts there, whatever the row's own
     * need, until your next prompt or the job's new session id. Set only while it is handed off.
     */
    handoffCard?: { source: 'block' | 'recap'; rule: string };
  };
  flag: { flagged: boolean; at?: string; rule: string };
  snooze: { snoozed: boolean; at?: string; until?: string; endedAt?: string; endedBy?: 'time' | 'woken' | 'pr'; endedByPr?: string; heldPrs?: string[]; backInNeedsYou?: 'time' | 'woken' | 'pr' };
  context: { tokens?: number; level?: 'ok' | 'warn' | 'high'; warnAbove: number; highAbove: number };
  inputs: Record<string, unknown>;
  /** The text the verdicts came from, for the caller to put under `untrusted`. */
  text: { waitingFor?: string; needsText?: string; prRef?: string };
}

/**
 * Explains `session` by the page's rules. `everyone` is every listed session and `prs` the PR list,
 * since which PR a session owns depends on the others (ownedPrsBySession()).
 */
export function explainState(session: SessionSummary, everyone: readonly SessionSummary[], prs: readonly PullRequestSummary[]): StateExplanation {
  const owned = ownedPrsBySession(everyone, prs).get(session.sessionId);
  const reason = needsYouReason(session, owned);
  const badge = statusBadge(session);
  const busy = isBusy(session);

  const needsYou: StateExplanation['needsYou'] = { inNeedsYou: reason.attention, indexSaysNeeds: indexNeedsYou(session) };
  if (reason.own !== undefined) needsYou.own = { reason: reason.own, rule: NEEDS_YOU_RULES[reason.own] };
  if (reason.setAside !== undefined) needsYou.setAside = reason.setAside;
  if (reason.pr !== undefined) needsYou.pr = { need: reason.pr.need, rule: PR_NEED_RULES[reason.pr.need], ...(reason.pr.via === undefined ? {} : { via: reason.pr.via }) };
  if (reason.won !== undefined) needsYou.won = reason.won;
  // A PR that needs you, held back because the session is busy (prNeedOf()).
  const held = busy ? owned?.find((pr) => prNeedKind(pr) !== undefined) : undefined;
  if (held !== undefined) needsYou.prHeldWhileBusy = { need: prNeedKind(held)! };

  if (isHandedOff(session) && session.spinOff?.kind === 'proposal') {
    needsYou.handoffCard = {
      source: session.spinOff.source === 'recap' ? 'recap' : 'block',
      rule: 'It handed itself over to free up context. Its card in Needs you offers Clear and continue with the prompt shown, until your next prompt or the job’s new session id.',
    };
  }

  const flagged = isFlagged(session);
  const snoozed = isSnoozed(session);
  const snooze: StateExplanation['snooze'] = { snoozed };
  if (session.snoozed !== undefined) {
    snooze.at = session.snoozed.at;
    if (session.snoozed.until !== undefined) snooze.until = session.snoozed.until;
    if (session.snoozed.heldPrs !== undefined && session.snoozed.heldPrs.length > 0) snooze.heldPrs = session.snoozed.heldPrs.map((held) => held.key);
  }
  if (session.snoozeEnded !== undefined) {
    snooze.endedAt = session.snoozeEnded.at;
    snooze.endedBy = session.snoozeEnded.why;
    if (session.snoozeEnded.pr !== undefined) snooze.endedByPr = session.snoozeEnded.pr.ref;
  }
  const back = snoozeBack(session);
  if (back !== undefined) snooze.backInNeedsYou = back;

  const context: StateExplanation['context'] = { warnAbove: CONTEXT_WARN_TOKENS, highAbove: CONTEXT_HIGH_TOKENS };
  if (session.contextTokens !== undefined) {
    context.tokens = session.contextTokens;
    context.level = contextLevel(session.contextTokens);
  }

  const inputs: Record<string, unknown> = {
    kind: session.kind,
    alive: session.alive,
    finished: session.finished,
    stale: session.stale,
    ...(session.ended === true ? { ended: true } : {}),
    ...(session.turnEnded === true ? { turnEnded: true } : {}),
    ...(session.state === undefined ? {} : { state: session.state }),
    ...(session.status === undefined ? {} : { processStatus: session.status }),
    ...(session.needsYou === undefined ? {} : { indexNeedsYou: session.needsYou.reason }),
    ...(session.recap === undefined
      ? {}
      : { recap: { source: session.recap.source, waitingOn: session.recap.waitingOn, ...(session.recap.stale === true ? { stale: true } : {}) } }),
    ownedPrs: owned?.length ?? 0,
  };

  const text: StateExplanation['text'] = {};
  if (session.waitingFor) text.waitingFor = session.waitingFor;
  if (session.needsYou?.text) text.needsText = session.needsYou.text;
  const prRef = reason.pr?.ref ?? (held === undefined ? undefined : `${held.repo}#${held.number}`);
  if (prRef !== undefined) text.prRef = prRef;

  return {
    status: {
      status: badge.status,
      label: badge.status === 'waiting' || badge.status === 'blocked' || badge.status === 'blocked-stale' ? badge.label.split(':')[0]! : badge.label,
      look: badge.look,
      ...(badge.dot === true ? { dot: true as const } : {}),
      ...(badge.setAside === true ? { setAside: true as const } : {}),
      rule: STATUS_RULES[badge.status],
    },
    busy: { busy, rule: BUSY_RULE },
    needsYou,
    flag: { flagged, ...(session.flagged === undefined ? {} : { at: session.flagged.at }), rule: SET_ASIDE_RULE },
    snooze,
    context,
    inputs,
    text,
  };
}
