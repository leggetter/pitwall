// A session row (docs/design-system.md, 4: Session rows), two lines at most: which session it is,
// its badges, when it was last active and its star toggle (W53); then what it needs or asked, or what
// it was last asked, after its group's label in Needs you, All sessions and Starred, and "Not needed
// now" while it's marked so (W88), and, quietly at its end, how many of its sub-agents are running
// while any are (W77), then, while it needs you or is marked, its Not needed now toggle, under the star. A finished session's row
// is muted, an ended interactive session's too (W67), with Ended as its status. The rest, such as its
// replies, its relay exchange, its directory, the repos it worked in and the message box, is in the
// session view, one click away.
//
// A session is a piece of work (W106, work.ts): its row carries the open pull requests it owns, the
// most urgent as a badge, "#128 CI failing", with "+2" for more. It needs you when the session does
// or when one of those PRs needs attention, and then line 2 says why, "CI is failing on #128", unless
// the session needs you itself, which comes first. A finished or ended session that owns an open PR
// isn't finished work, so its row isn't muted; its badge still says Ended.
//
// Tooltips, on hover only, since none of them is on the name's button: the session's id and start
// time on its name; the whole title and where it came from; Stale's and a finished Asked you's
// explanations; the last activity's absolute time; and line 2 in full when it's cut short. The full
// title and line 2 are in the DOM too, so screen readers have them. The session view has them all:
// the title in its heading, the question or prompt in its conversation, and Stale and Asked you in
// its line 2, each with an info button whose name is its explanation, so the keyboard reaches it.

import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { prNeedsAttention, type PullRequestSummary, type SessionGroup, type SessionSummary } from '../../../src/shared/protocol.js';
import { absoluteTime, plainText } from '../format.js';
import type { NotNeeded } from '../notNeeded.js';
import { prReason, sessionPrBadge } from '../prs.js';
import { ENDED_RECAP_HINT, FINISHED_RECAP_HINT, finishedWaitingOnYou, quietWaitingOn, WAITING_ON_TEXT } from '../recap.js';
import { groupLabel, isNotNeeded, needsAttention, needsText, recapNeedsText, rowStatusBadge } from '../sessions.js';
import { runningText } from '../subagents.js';
import { Badge, StatusBadge } from './Badge.js';
import { Highlight } from './Highlight.js';
import { NotNeededButton } from './NotNeededButton.js';
import { SessionPrBadgeView } from './PrBadges.js';
import { StarButton } from './StarButton.js';
import { Timestamp } from './Timestamp.js';
import { Tooltip } from './Tooltip.js';

export const STALE_HINT =
  'Blocked with no activity for more than 7 days, whether or not its process is running. Usually waiting on a question that no longer matters.';
export const FINISHED_ASKED_HINT = "Its last message asked you something. It has finished, so it isn't counted as needing you.";
/** The same, for an ended interactive session (W67), whose badge says Ended rather than finished. */
export const ENDED_ASKED_HINT = "Its last message asked you something. It has ended, so it isn't counted as needing you.";

/** The hint for a finished session's Asked you: an ended one's, or a finished background session's. */
export function finishedAskedHint(session: SessionSummary): string {
  return session.ended ? ENDED_ASKED_HINT : FINISHED_ASKED_HINT;
}
const TITLE_HINTS: Record<NonNullable<SessionSummary['titleSource']>, string> = {
  'claude-code': "Claude Code's title, from the session's first prompt",
  pitwall: "pitwall's title, from the session's recent turns",
};

/** Line 2's label for what a recap says you need to do (W111), as "Asked:" and "Needs:" are. */
export const RECAP_NEXT_LABEL = 'Next:';

/** The hint for a finished or ended session's Waiting on you (W111): it isn't counted as needing you. */
export function finishedRecapHint(session: SessionSummary): string {
  return session.ended ? ENDED_RECAP_HINT : FINISHED_RECAP_HINT;
}

/** What a row marked not needed now says on line 2, quietly, after its group's label (W88). */
export const NOT_NEEDED_TEXT = 'Not needed now';

/** The id of the session view, which every row's name controls. */
export const SESSION_VIEW_ID = 'session-view';

/** The title's tooltip: the whole title, which may be cut short on screen, and where it came from. The session view's heading has it too. */
export function titleHint(title: string, source: SessionSummary['titleSource']): string {
  const from = source === undefined ? undefined : TITLE_HINTS[source];
  return from === undefined ? title : `${title}\n${from}`;
}

/** Clicks on these inside a row do their own thing, rather than opening the session. */
const OWN_CLICK = 'a, button, input, select, textarea, label, summary, [role="button"]';

/**
 * Line 2: what a background job's own line says it needs (W69), or what its recap says it's waiting
 * on you for (M5, W111), or what the session asked you, or else what you last asked it, or why the
 * transcript can't say.
 */
function whatItWants(session: SessionSummary): { content: ReactNode; hint?: string } | undefined {
  // Claude Code's line, from the job's file, not the transcript: shown whatever the transcript's state.
  const needs = needsText(session);
  if (needs !== undefined) {
    const text = plainText(needs);
    return {
      content: (
        <span className="asked">
          <span className="asked-label">Needs:</span> {text}
        </span>
      ),
      hint: text,
    };
  }
  // Its recap's `next`, from the index's recap, not the transcript: shown whatever the transcript's
  // state, as Needs is. "Next:", as Asked and Needs have theirs: the badge already says it waits on you.
  // With no next, the badge says it all, and line 2 says what it did last.
  const next = recapNeedsText(session);
  if (next !== undefined) {
    const text = plainText(next);
    return {
      content: (
        <span className="asked">
          <span className="asked-label">{RECAP_NEXT_LABEL}</span> {text}
        </span>
      ),
      hint: text,
    };
  }
  if (session.transcript !== 'ok') {
    return { content: <span className="transcript-note">Transcript {session.transcript === 'missing' ? 'not found' : 'unreadable'}</span> };
  }
  if (session.askedYou) {
    const excerpt = plainText(session.askedYou.excerpt);
    return {
      content: (
        <span className="asked">
          <span className="asked-label">Asked:</span> {excerpt}
        </span>
      ),
      hint: excerpt,
    };
  }
  if (session.lastUserPrompt) {
    const prompt = plainText(session.lastUserPrompt);
    return {
      content: (
        <span className="prompt">
          <span className="who">You:</span> {prompt}
        </span>
      ),
      hint: prompt,
    };
  }
  return undefined;
}

export interface SessionRowProps {
  session: SessionSummary;
  /** The group it's listed under: in Needs you and All sessions, its home group as Group sessions by says (W42). */
  group: Pick<SessionGroup, 'root' | 'key' | 'label'>;
  /**
   * Start line 2 with the group's label: in Needs you and All sessions, which list every group. In a
   * group's own list there's no label, since the heading names the group.
   */
  showGroup?: boolean;
  /** Opens the session view. Clicking the name, or anywhere on the row that isn't a control, calls it. */
  onOpen?: ((sessionId: string) => void) | undefined;
  /** ↑ or ↓ on the name: the next or previous row (docs/design-system.md, 6.2). */
  onStep?: ((sessionId: string, by: 1 | -1) => void) | undefined;
  /** This session's view is open. */
  isOpen?: boolean;
  /** Whether it's starred (W53), for its star toggle. */
  starred?: boolean;
  /** Stars or unstars it: the star toggle at the end of line 1, which there's none without. */
  onStar?: ((sessionId: string, on: boolean) => void) | undefined;
  /** The viewer's Not needed now marks (W88), so a marked session's row is quiet. */
  notNeeded?: NotNeeded | undefined;
  /** Marks it not needed now, or takes the mark away: its toggle, while it needs you, which there's none without. */
  onNotNeeded?: ((session: SessionSummary, on: boolean) => void) | undefined;
  /**
   * The open pull requests it owns (W106, work.ts), most urgent first: a badge before its status
   * badge for the first, "#128 CI failing", with "+2" for more, in subtle danger while that PR needs
   * attention. One it's only linked to, or that another session has taken over, isn't here.
   */
  owned?: readonly PullRequestSummary[] | undefined;
}

export function SessionRow({ session, group, showGroup = false, onOpen, onStep, isOpen = false, starred = false, onStar, notNeeded, onNotNeeded, owned }: SessionRowProps) {
  // Marked not needed now (W88): it still needs you, by the index, but has no bar, its badge is outlined, and line 2 says so.
  const marked = isNotNeeded(session, notNeeded);
  // It needs you itself, or a PR it owns does (W106).
  const own = needsAttention(session, notNeeded);
  const prNeed = owned?.find(prNeedsAttention);
  const attention = own || prNeed !== undefined;
  // An ended or finished session that owns an open PR isn't finished work (W106).
  const finished = session.finished && (owned?.length ?? 0) === 0;
  const badge = rowStatusBadge(session, notNeeded);
  const name = plainText(session.name);
  const title = session.title ? plainText(session.title) : '';
  const reason = !own && prNeed !== undefined ? prReason(prNeed, true) : undefined;
  const wants: { content: ReactNode; hint?: string } | undefined =
    reason !== undefined ? { content: <span className="asked pr-reason">{reason}</span>, hint: reason } : whatItWants(session);
  // What an idle session's recap says it waits on, when that isn't you (W111): quiet, first on line 2, never needing you.
  const waitingOn = quietWaitingOn(session, attention);
  const pr = sessionPrBadge(owned);
  // Line 2's label: the group's, in Needs you and All sessions.
  const label = showGroup ? plainText(groupLabel(group)) : undefined;
  // How many of its sub-agents are running, at the end of line 2, while any are (W77).
  const running = session.subagentsRunning !== undefined && session.subagentsRunning > 0 ? runningText(session.subagentsRunning) : undefined;

  const openFromRow = (event: MouseEvent<HTMLLIElement>) => {
    if (!onOpen) return;
    if (event.target instanceof Element && event.target.closest(OWN_CLICK)) return;
    // Selecting text to copy it isn't a click on the row.
    if ((window.getSelection()?.toString() ?? '') !== '') return;
    onOpen(session.sessionId);
  };
  const onNameKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!onStep || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    // Not the list's scroll: focus moves, and the browser scrolls the row it lands on into view.
    event.preventDefault();
    onStep(session.sessionId, event.key === 'ArrowDown' ? 1 : -1);
  };
  const className = ['session', attention && 'attention', marked && 'not-needed', finished && 'finished', onOpen && 'openable', isOpen && 'open', onStar && starred && 'starred']
    .filter(Boolean)
    .join(' ');
  const badges = [
    // First, so the status badges still line up down the list against the time's slot (W95).
    pr && <SessionPrBadgeView key="pr" badge={pr} />,
    badge && <StatusBadge key="status" badge={badge} />,
    session.finished && session.askedYou && (
      <Badge key="asked" look="outline" hint={finishedAskedHint(session)}>
        Asked you
      </Badge>
    ),
    finishedWaitingOnYou(session) && (
      <Badge key="recap" look="outline" hint={finishedRecapHint(session)}>
        {WAITING_ON_TEXT.you}
      </Badge>
    ),
    session.stale && (
      <Badge key="stale" look="subtle-neutral" className="stale" hint={STALE_HINT}>
        Stale
      </Badge>
    ),
  ].filter(Boolean);

  // Line 2, when there's anything to say (W88's toggle has a line 2 to itself when there isn't).
  const line2 = (label !== undefined || wants || running || marked || waitingOn !== undefined) && (
    <Tooltip content={wants?.hint} relation="none" onlyIfCut>
      <p className="session-what">
        {/* What gives way, with an ellipsis, before the running count does. */}
        <span className="session-what-text">
          {label !== undefined && (
            <>
              <span className="session-group">
                <Highlight text={label} />
              </span>
              {(marked || wants || waitingOn !== undefined) && (
                <span className="session-what-sep" aria-hidden="true">
                  {' · '}
                </span>
              )}
            </>
          )}
          {waitingOn !== undefined && (
            // Quiet, as the group's label is, and before what it last did, so it's seen when that's cut short.
            <>
              <span className="session-waiting-on">{waitingOn}</span>
              {wants && (
                <span className="session-what-sep" aria-hidden="true">
                  {' · '}
                </span>
              )}
            </>
          )}
          {marked && (
            // Quiet, as the group's label is, and before what it needs, so it's seen when that's cut short.
            <>
              <span className="session-not-needed">{NOT_NEEDED_TEXT}</span>
              {wants && (
                <span className="session-what-sep" aria-hidden="true">
                  {' · '}
                </span>
              )}
            </>
          )}
          {wants?.content}
        </span>
        {running !== undefined && (
          // Quiet, and never cut: "· 2 sub-agents running", after whatever is before it.
          <span className="session-running">
            {(label !== undefined || wants || marked || waitingOn !== undefined) && (
              <span className="session-what-sep" aria-hidden="true">
                {' · '}
              </span>
            )}
            {running}
          </span>
        )}
      </p>
    </Tooltip>
  );
  // While it needs you itself, or is marked not needed now (W88): a mark is for what the session needs, never its PRs'. Shown while it's marked, otherwise on hover and focus.
  const toggle = onNotNeeded && (own || marked) && (
    <NotNeededButton sessionId={session.sessionId} name={session.name} marked={marked} onChange={(on) => onNotNeeded(session, on)} className="session-not-needed-toggle" />
  );

  return (
    <li className={className} data-attention={attention || undefined} onClick={openFromRow}>
      <div className="session-line">
        <div className="session-ident">
          <Tooltip content={`Session ${session.sessionId}, started ${absoluteTime(session.startedAt)}`} relation="none">
            <h3 className="session-name">
              {onOpen ? (
                <button
                  type="button"
                  className="session-open"
                  data-open-session={session.sessionId}
                  aria-controls={SESSION_VIEW_ID}
                  aria-current={isOpen || undefined}
                  onClick={() => onOpen(session.sessionId)}
                  onKeyDown={onNameKey}
                >
                  <Highlight text={name} />
                </button>
              ) : (
                <Highlight text={name} />
              )}
            </h3>
          </Tooltip>
          {title && (
            // The " · " before it is drawn by CSS, so it goes with the title when the row is narrow.
            <Tooltip content={titleHint(title, session.titleSource)} relation="none" onlyIfCut={session.titleSource === undefined}>
              <span className="session-title">
                <Highlight text={title} />
              </span>
            </Tooltip>
          )}
        </div>
        {badges.length > 0 && <span className="session-badges">{badges}</span>}
        {session.lastActivityAt && <Timestamp className="activity" at={session.lastActivityAt} />}
        {/* Always shown while it's starred; otherwise on hover and focus, so the list stays calm. */}
        {onStar && <StarButton sessionId={session.sessionId} name={session.name} starred={starred} onStar={onStar} size="sm" className="session-star" />}
      </div>
      {toggle ? (
        // While it needs you, or is marked: line 2 ends with the toggle, under the star, and gives way before it.
        <div className="session-line-2">
          {line2}
          {toggle}
        </div>
      ) : (
        line2
      )}
    </li>
  );
}
