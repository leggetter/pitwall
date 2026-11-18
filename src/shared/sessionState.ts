// How a session's state and badges are decided (W178), in one place for the page and the server. The
// page draws the badges (web/src/sessions.ts and the components re-export these); the server's why_state
// tool (src/server/whyState.ts) explains them from this same code, so the two can't disagree. Pure, and
// no text from a session beyond what the badge's label carries.
import { CONTEXT_HIGH_TOKENS, CONTEXT_WARN_TOKENS, type RecapWaitingOn, type SessionSummary } from './protocol.js';
import { indexNeedsYou, isBusy, needsAttention } from './needsYou.js';

/**
 * A session that needs you, by the index, but that you flagged as not needing you (W153), for what
 * it needs now: the server sets `flagged` only while that holds. Its row keeps its badge, outlined,
 * and says "You flagged this", with its flag toggle pressed.
 */
export function isFlagged(session: SessionSummary): boolean {
  return indexNeedsYou(session) && session.flagged !== undefined;
}

/**
 * A session that needs you, by the index, but that you snoozed (W154): its row keeps its badge,
 * outlined, and says until when, with its snooze toggle pressed.
 */
export function isSnoozed(session: SessionSummary): boolean {
  return indexNeedsYou(session) && session.snoozed !== undefined;
}

/**
 * A flag (W153) or a snooze (W154) has set it aside: it needs you, by the index, but not by you. Its
 * row is quiet and its badge outlined, whatever its status, which it keeps.
 */
export function isSetAside(session: SessionSummary): boolean {
  return isFlagged(session) || isSnoozed(session);
}

/**
 * Why it's back in Needs you after a snooze ended by itself (W154, SessionSummary.snoozeEnded), while
 * it needs you and the server still says so: its time was up, or a turn you didn't start woke it.
 */
export function snoozeBack(session: SessionSummary): 'time' | 'woken' | undefined {
  return needsAttention(session) ? session.snoozeEnded?.why : undefined;
}

/**
 * How a badge looks (docs/design-system.md, 4: Badges): solid is for "needs you" only, everything
 * else is subtle, in a tone, or outline.
 */
export type BadgeLook = 'solid-warning' | 'subtle-warning' | 'subtle-info' | 'subtle-neutral' | 'subtle-success' | 'subtle-danger' | 'outline';

/** What a session waits on, other than nothing, as line 2 and the badges say it. */
export const WAITING_ON_TEXT: Readonly<Record<Exclude<RecapWaitingOn, 'nothing'>, string>> = {
  you: 'Waiting on you',
  CI: 'Waiting on CI',
  'another session': 'Waiting on another session',
  'someone else': 'Waiting on someone else',
};

/** What a session waits on when it isn't you or nothing (W170). */
export type WaitingElsewhere = Exclude<RecapWaitingOn, 'you' | 'nothing'>;

/**
 * What a session's current recap, pitwall's, says it waits on, when that's CI, someone else or another
 * session: never you or nothing, and never from a recap older than its latest turn (stale), from Claude
 * Code's, which says nothing of what it waits on, or for an ended session.
 */
export function waitingElsewhere(session: SessionSummary): WaitingElsewhere | undefined {
  const recap = session.recap;
  if (!recap || recap.stale || recap.source !== 'pitwall' || session.ended) return undefined;
  return recap.waitingOn === 'you' || recap.waitingOn === 'nothing' ? undefined : recap.waitingOn;
}

/** The session states the badges tell apart, as in the Badges table. */
export type SessionStatus =
  | 'waiting'
  | 'blocked'
  | 'restarted'
  | 'asked'
  | 'recap'
  | 'blocked-stale'
  | 'failed'
  | 'waiting-on'
  | 'done'
  | 'stopped'
  | 'ended'
  | 'not-running'
  | 'busy'
  | 'working'
  | 'idle'
  | 'unknown';

export interface StatusBadge {
  status: SessionStatus;
  /** The visible text, in sentence case, such as "Waiting: permission prompt". */
  label: string;
  look: BadgeLook;
  /** An 8 px status dot before the label: busy and working. */
  dot?: boolean;
  /** Flagged (W153) or snoozed (W154): outlined, whatever its status, which it keeps, as its label does. */
  setAside?: true;
}

/**
 * Why it needs you first, by NeedsYou's reason (W69): the solid badges are for those alone. Then the
 * session's state or status.
 * - 'prompt': "Waiting: *reason*", as Claude Code gives waitingFor.
 * - 'claude-code' and 'blocked': "Blocked". The job's own line is on the row's line 2.
 * - 'restarted': "Waiting for your prompt".
 * - 'asked': "Asked you", subtle, as before W69.
 * - 'recap': "Waiting on you", subtle as Asked you is (M5, W111): its current recap says it's waiting
 *   on you, as a job Claude Code calls done can be (Phil, 2026-10-29). It takes Done's place. A session
 *   that is also busy (W174) keeps Busy's 8 px dot before the label.
 * A job Claude Code calls done whose current recap says it waits on someone else, on CI or on another
 * session shows "Waiting on someone else", "Waiting on CI" or "Waiting on another session" in Done's
 * place, subtle and neutral, never needing you (W170): "it's still marked as DONE" (Phil, 2026-11-09).
 * A blocked job that needs nothing of you shows as its process does: idle, with no badge in the list
 * and "Idle" in the session view, or Busy, or Not running. A stale one keeps its "Blocked" text,
 * outlined. A finished session shows its state (done, stopped or failed) even when it asked
 * something; its row shows that separately, as an outline badge. An ended interactive session
 * (W67), whose process has exited, shows Ended, as a stopped one shows Stopped: it has no status or
 * state.
 *
 * One flagged (W153) or snoozed (W154) keeps its badge's text, outlined, as a stale blocked job's is:
 * solid is for needing you only.
 */
export function statusBadge(session: SessionSummary): StatusBadge {
  const badge = needsBadge(session);
  return isSetAside(session) ? { ...badge, look: 'outline', setAside: true } : badge;
}

function needsBadge(session: SessionSummary): StatusBadge {
  if (session.ended) return { status: 'ended', label: 'Ended', look: 'subtle-neutral' };
  const reason = session.waitingFor ? `: ${session.waitingFor}` : '';
  switch (indexNeedsYou(session) ? session.needsYou?.reason : undefined) {
    case 'prompt':
      return { status: 'waiting', label: `Waiting${reason}`, look: 'solid-warning' };
    case 'claude-code':
    case 'blocked':
      return { status: 'blocked', label: `Blocked${reason}`, look: 'solid-warning' };
    case 'restarted':
      return { status: 'restarted', label: 'Waiting for your prompt', look: 'solid-warning' };
    case 'asked':
      return { status: 'asked', label: 'Asked you', look: 'subtle-warning' };
    case 'recap':
      // At work too (W174): the busy dot stays, so a session that is busy and waits on you shows both.
      return { status: 'recap', label: 'Waiting on you', look: 'subtle-warning', ...(isBusy(session) ? { dot: true } : {}) };
  }
  // A stale blocked job keeps its "Blocked" text but loses the attention styling.
  if (session.state === 'blocked' && session.stale) return { status: 'blocked-stale', label: `Blocked${reason}`, look: 'outline' };
  if (session.state === 'failed') return { status: 'failed', label: 'Failed', look: 'subtle-danger' };
  if (session.state === 'done') {
    // Claude Code calls it done, but its recap says it waits on someone else, CI or another session (W170).
    const waiting = waitingElsewhere(session);
    if (waiting !== undefined) return { status: 'waiting-on', label: WAITING_ON_TEXT[waiting], look: 'subtle-neutral' };
    return { status: 'done', label: 'Done', look: 'subtle-success' };
  }
  if (session.state === 'stopped') return { status: 'stopped', label: 'Stopped', look: 'subtle-neutral' };
  if (!session.alive) return { status: 'not-running', label: 'Not running', look: 'outline' };
  if (session.status === 'busy') return { status: 'busy', label: 'Busy', look: 'subtle-info', dot: true };
  // Blocked, though its context says it needs nothing of you, as a resumed session's "send a prompt to start": idle.
  if (session.status === 'idle' || session.state === 'blocked') return { status: 'idle', label: 'Idle', look: 'subtle-neutral' };
  if (session.state === 'working') return { status: 'working', label: 'Working', look: 'subtle-info', dot: true };
  return { status: 'unknown', label: 'Unknown', look: 'subtle-neutral' };
}

export type ContextLevel = 'ok' | 'warn' | 'high';

/** How loud the context badge is (W133): over CONTEXT_WARN_TOKENS warn, over CONTEXT_HIGH_TOKENS high. */
export function contextLevel(tokens: number): ContextLevel {
  if (tokens > CONTEXT_HIGH_TOKENS) return 'high';
  if (tokens > CONTEXT_WARN_TOKENS) return 'warn';
  return 'ok';
}
