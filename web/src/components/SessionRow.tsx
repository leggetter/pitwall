// A session row (docs/design-system.md, 4: Session rows), two lines at most: which session it is,
// its badges and when it was last active; then what it asked, or what it was last asked. The rest,
// such as its replies, its relay exchange, its directory and the message box, is in the session
// view, one click away.

import type { MouseEvent, ReactNode } from 'react';
import type { SessionGroup, SessionSummary } from '../../../src/shared/protocol.js';
import { absoluteTime, plainText, relativeTime } from '../format.js';
import { groupLabel, needsAttention, rowStatusBadge } from '../sessions.js';
import { Badge, StatusBadge } from './Badge.js';
import { Highlight } from './Highlight.js';

export const STALE_HINT =
  'Blocked with no activity for more than 7 days, whether or not its process is running. Usually waiting on a question that no longer matters.';
export const FINISHED_ASKED_HINT = "Its last message asked you something. It has finished, so it isn't counted as needing you.";
const TITLE_HINTS: Record<NonNullable<SessionSummary['titleSource']>, string> = {
  'claude-code': "Claude Code's title, from the session's first prompt",
  pitwall: "pitwall's title, from the session's recent turns",
};

/** The id of the session view, which every row's name controls. */
export const SESSION_VIEW_ID = 'session-view';

/** The title's hover text: the whole title, which may be cut short on screen, and where it came from. */
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
  /** The group it's listed under. */
  group: Pick<SessionGroup, 'root' | 'key' | 'label'>;
  /** Start line 2 with the group's label: in Needs you and All sessions, which list every group. */
  showGroup?: boolean;
  now: number;
  /** Opens the session view. Clicking the name, or anywhere on the row that isn't a control, calls it. */
  onOpen?: ((sessionId: string) => void) | undefined;
  /** This session's view is open. */
  isOpen?: boolean;
}

export function SessionRow({ session, group, showGroup = false, now, onOpen, isOpen = false }: SessionRowProps) {
  const attention = needsAttention(session);
  const { finished } = session;
  const badge = rowStatusBadge(session);
  const name = plainText(session.name);
  const title = session.title ? plainText(session.title) : '';
  const wants = whatItWants(session);

  const openFromRow = (event: MouseEvent<HTMLLIElement>) => {
    if (!onOpen) return;
    if (event.target instanceof Element && event.target.closest(OWN_CLICK)) return;
    // Selecting text to copy it isn't a click on the row.
    if ((window.getSelection()?.toString() ?? '') !== '') return;
    onOpen(session.sessionId);
  };
  const className = ['session', attention && 'attention', finished && 'finished', onOpen && 'openable', isOpen && 'open']
    .filter(Boolean)
    .join(' ');
  const badges = [
    badge && <StatusBadge key="status" badge={badge} />,
    finished && session.askedYou && (
      <Badge key="asked" look="outline" title={FINISHED_ASKED_HINT}>
        Asked you
      </Badge>
    ),
    session.stale && (
      <Badge key="stale" look="subtle-neutral" className="stale" title={STALE_HINT}>
        Stale
      </Badge>
    ),
  ].filter(Boolean);

  return (
    <li className={className} data-attention={attention || undefined} onClick={openFromRow}>
      <div className="session-line">
        <div className="session-ident">
          <h3 className="session-name" title={`Session ${session.sessionId}, started ${absoluteTime(session.startedAt)}`}>
            {onOpen ? (
              <button
                type="button"
                className="session-open"
                data-open-session={session.sessionId}
                aria-controls={SESSION_VIEW_ID}
                aria-current={isOpen || undefined}
                onClick={() => onOpen(session.sessionId)}
              >
                <Highlight text={name} />
              </button>
            ) : (
              <Highlight text={name} />
            )}
          </h3>
          {title && (
            // The " · " before it is drawn by CSS, so it goes with the title when the row is narrow.
            <span className="session-title" title={titleHint(title, session.titleSource)}>
              <Highlight text={title} />
            </span>
          )}
        </div>
        {badges.length > 0 && <span className="session-badges">{badges}</span>}
        {session.lastActivityAt && (
          <time className="activity" dateTime={session.lastActivityAt} title={absoluteTime(session.lastActivityAt)}>
            {relativeTime(session.lastActivityAt, now)}
          </time>
        )}
      </div>
      {(showGroup || wants) && (
        <p className="session-what" title={wants?.hint}>
          {showGroup && (
            <>
              <span className="session-group">
                <Highlight text={plainText(groupLabel(group))} />
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
      )}
    </li>
  );
}
