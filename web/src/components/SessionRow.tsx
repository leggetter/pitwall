// A session row (docs/design-system.md, 4: Session rows), two lines at most: which session it is,
// its badges, when it was last active and its star toggle (W53); then what it asked, or what it was
// last asked, after its group's label in Needs you, All sessions and Starred. The rest, such as its replies, its relay exchange, its
// directory, the repos it worked in and the message box, is in the session view, one click away.
//
// Tooltips, on hover only, since none of them is on the name's button: the session's id and start
// time on its name; the whole title and where it came from; Stale's and a finished Asked you's
// explanations; the last activity's absolute time; and line 2 in full when it's cut short. The full
// title and line 2 are in the DOM too, so screen readers have them. The session view has them all:
// the title in its heading, the question or prompt in its conversation, and Stale and Asked you in
// its line 2, each with an info button whose name is its explanation, so the keyboard reaches it.

import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import type { SessionGroup, SessionSummary } from '../../../src/shared/protocol.js';
import { absoluteTime, plainText } from '../format.js';
import { groupLabel, needsAttention, rowStatusBadge } from '../sessions.js';
import { Badge, StatusBadge } from './Badge.js';
import { Highlight } from './Highlight.js';
import { StarButton } from './StarButton.js';
import { Timestamp } from './Timestamp.js';
import { Tooltip } from './Tooltip.js';

export const STALE_HINT =
  'Blocked with no activity for more than 7 days, whether or not its process is running. Usually waiting on a question that no longer matters.';
export const FINISHED_ASKED_HINT = "Its last message asked you something. It has finished, so it isn't counted as needing you.";
const TITLE_HINTS: Record<NonNullable<SessionSummary['titleSource']>, string> = {
  'claude-code': "Claude Code's title, from the session's first prompt",
  pitwall: "pitwall's title, from the session's recent turns",
};

/** The id of the session view, which every row's name controls. */
export const SESSION_VIEW_ID = 'session-view';

/** The title's tooltip: the whole title, which may be cut short on screen, and where it came from. */
function titleHint(title: string, source: SessionSummary['titleSource']): string {
  const from = source === undefined ? undefined : TITLE_HINTS[source];
  return from === undefined ? title : `${title}\n${from}`;
}

/** Clicks on these inside a row do their own thing, rather than opening the session. */
const OWN_CLICK = 'a, button, input, select, textarea, label, summary, [role="button"]';

/** Line 2: what the session asked you, or else what you last asked it, or why the transcript can't say. */
function whatItWants(session: SessionSummary): { content: ReactNode; hint?: string } | undefined {
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
  /** The group it's listed under: in Needs you and All sessions, its home group as View preferences says (W42). */
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
}

export function SessionRow({ session, group, showGroup = false, onOpen, onStep, isOpen = false, starred = false, onStar }: SessionRowProps) {
  const attention = needsAttention(session);
  const { finished } = session;
  const badge = rowStatusBadge(session);
  const name = plainText(session.name);
  const title = session.title ? plainText(session.title) : '';
  const wants = whatItWants(session);
  // Line 2's label: the group's, in Needs you and All sessions.
  const label = showGroup ? plainText(groupLabel(group)) : undefined;

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
  const className = ['session', attention && 'attention', finished && 'finished', onOpen && 'openable', isOpen && 'open', onStar && starred && 'starred']
    .filter(Boolean)
    .join(' ');
  const badges = [
    badge && <StatusBadge key="status" badge={badge} />,
    finished && session.askedYou && (
      <Badge key="asked" look="outline" hint={FINISHED_ASKED_HINT}>
        Asked you
      </Badge>
    ),
    session.stale && (
      <Badge key="stale" look="subtle-neutral" className="stale" hint={STALE_HINT}>
        Stale
      </Badge>
    ),
  ].filter(Boolean);

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
      {(label !== undefined || wants) && (
        <Tooltip content={wants?.hint} relation="none" onlyIfCut>
          <p className="session-what">
            {label !== undefined && (
              <>
                <span className="session-group">
                  <Highlight text={label} />
                </span>
                {wants && (
                  <span className="session-what-sep" aria-hidden="true">
                    {' · '}
                  </span>
                )}
              </>
            )}
            {wants?.content}
          </p>
        </Tooltip>
      )}
    </li>
  );
}
