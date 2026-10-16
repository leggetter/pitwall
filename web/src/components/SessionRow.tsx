import type { MouseEvent } from 'react';
import type { SessionSummary } from '../../../src/shared/protocol.js';
import { absoluteTime, cwdWithinGroup, plainText, relativeTime } from '../format.js';
import { attachCommand, needsAttention, statusPill } from '../sessions.js';
import { CopyCommand } from './CopyCommand.js';
import { Reply } from './Reply.js';

const STALE_HINT =
  'Blocked with no activity for more than 7 days, whether or not its process is running. Usually waiting on a question that no longer matters.';
const CWD_MISSING_HINT = 'The working directory no longer exists, for example after a worktree was removed.';
const TITLE_HINTS: Record<NonNullable<SessionSummary['titleSource']>, string> = {
  'claude-code': "Claude Code's title, from the session's first prompt",
  pitwall: "pitwall's title, from the session's recent turns",
};

/** The title's hover text: the whole title, which may be cut short on screen, and where it came from. */
function titleHint(title: string, source: SessionSummary['titleSource']): string {
  const from = source === undefined ? undefined : TITLE_HINTS[source];
  return from === undefined ? title : `${title}\n${from}`;
}

/** Clicks on these inside a row do their own thing, rather than opening the session. */
const OWN_CLICK = 'a, button, input, select, textarea, label, summary, [role="button"]';

export interface SessionRowProps {
  session: SessionSummary;
  groupKey: string;
  now: number;
  /** Opens the session view. Clicking the name, or anywhere on the row that isn't a control, calls it. */
  onOpen?: ((sessionId: string) => void) | undefined;
  /** This session's view is open. */
  isOpen?: boolean;
}

export function SessionRow({ session, groupKey, now, onOpen, isOpen = false }: SessionRowProps) {
  const attention = needsAttention(session);
  const pill = statusPill(session);
  const where = cwdWithinGroup(session.cwd, groupKey);
  const command = attachCommand(session);
  const name = plainText(session.name);
  const title = session.title ? plainText(session.title) : '';

  const openFromRow = (event: MouseEvent<HTMLLIElement>) => {
    if (!onOpen) return;
    if (event.target instanceof Element && event.target.closest(OWN_CLICK)) return;
    // Selecting text to copy it isn't a click on the row.
    if ((window.getSelection()?.toString() ?? '') !== '') return;
    onOpen(session.sessionId);
  };
  const className = ['session', attention && 'attention', onOpen && 'openable', isOpen && 'open'].filter(Boolean).join(' ');

  return (
    <li className={className} data-attention={attention || undefined} onClick={openFromRow}>
      <div className="session-head">
        <div className="session-ident">
          <h3 className="session-name" title={`Session ${session.sessionId}, started ${absoluteTime(session.startedAt)}`}>
            {onOpen ? (
              <button
                type="button"
                className="session-open"
                data-open-session={session.sessionId}
                aria-haspopup="dialog"
                aria-current={isOpen || undefined}
                onClick={() => onOpen(session.sessionId)}
              >
                {name}
              </button>
            ) : (
              name
            )}
          </h3>
          {title && (
            <>
              <span className="session-title-sep" aria-hidden="true">
                ·
              </span>
              <span className="session-title" title={titleHint(title, session.titleSource)}>
                {title}
              </span>
            </>
          )}
        </div>
        <span className="kind">{session.kind}</span>
        <span className={`pill tone-${pill.tone}`}>{plainText(pill.label)}</span>
        {session.stale && (
          <span className="stale" title={STALE_HINT}>
            stale
          </span>
        )}
        {session.lastActivityAt && (
          <time className="activity" dateTime={session.lastActivityAt} title={absoluteTime(session.lastActivityAt)}>
            {relativeTime(session.lastActivityAt, now)}
          </time>
        )}
      </div>

      {session.transcript === 'ok' ? (
        <>
          {session.lastUserPrompt && (
            <p className="prompt" title={plainText(session.lastUserPrompt)}>
              <span className="who">You</span> {plainText(session.lastUserPrompt)}
            </p>
          )}
          {session.askedYou && (
            <p className="asked">
              <span className="asked-label">Asked:</span> {plainText(session.askedYou.excerpt)}
            </p>
          )}
          {session.lastAssistantText && <Reply session={session} />}
        </>
      ) : (
        <p className="transcript-note">Transcript {session.transcript === 'missing' ? 'not found' : 'unreadable'}</p>
      )}

      {(where || session.cwdMissing || command) && (
        <div className="session-foot">
          {where && (
            <span className="cwd" title={plainText(session.cwd)}>
              {plainText(where)}
            </span>
          )}
          {session.cwdMissing && (
            <span className="cwd-missing" title={CWD_MISSING_HINT}>
              directory no longer exists
            </span>
          )}
          {command && <CopyCommand command={command} />}
        </div>
      )}
    </li>
  );
}
