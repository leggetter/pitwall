import { useId } from 'react';
import type { SessionGroup, SessionSummary } from '../../../src/shared/protocol.js';
import { plainText, shortenHome } from '../format.js';
import { countAttention, needYou, splitFinished } from '../sessions.js';
import { Highlight } from './Highlight.js';
import { ChevronIcon, FolderIcon, GitIcon } from './icons.js';
import { SessionRow } from './SessionRow.js';

export interface GroupSectionProps {
  group: SessionGroup;
  /** The sessions left after filtering. */
  sessions: SessionSummary[];
  collapsed: boolean;
  onToggle: () => void;
  /**
   * Whether the "Finished" sub-list, of background sessions that are done,
   * stopped or failed, is closed. Default true.
   */
  finishedCollapsed?: boolean;
  onToggleFinished?: (() => void) | undefined;
  /**
   * List the finished sessions with the others, after them, with no Finished sub-list: the Finished
   * filter chip is on, so they're what was asked for. The sub-list's own state is kept for later.
   */
  listFinished?: boolean;
  /** Show which root the group sits under, when pitwall watches more than one. */
  showRoot: boolean;
  now: number;
  /** Opens a session's view. */
  onOpen?: ((sessionId: string) => void) | undefined;
  /** The session whose view is open, if any. */
  openSessionId?: string | undefined;
}

export function GroupSection({
  group,
  sessions,
  collapsed,
  onToggle,
  finishedCollapsed = true,
  onToggleFinished,
  listFinished = false,
  showRoot,
  now,
  onOpen,
  openSessionId,
}: GroupSectionProps) {
  const headingId = useId();
  const listId = useId();
  const finishedId = useId();
  const split = splitFinished(sessions);
  // With the Finished chip on, the finished rows come after the others, in the same list.
  const current = listFinished ? [...split.current, ...split.finished] : split.current;
  const finished = listFinished ? [] : split.finished;
  // Counted on the Finished line, so a question isn't hidden behind the collapse. Never as "need you".
  const finishedAsked = finished.reduce((count, session) => count + (session.askedYou ? 1 : 0), 0);
  const total = group.sessions.length;
  // Finished sessions never count here: needsAttention leaves them out.
  const attention = countAttention(group.sessions);
  const count = sessions.length === total ? `${total} ${total === 1 ? 'session' : 'sessions'}` : `${sessions.length} of ${total} sessions`;

  return (
    <section className={attention > 0 ? 'group has-attention' : 'group'} aria-labelledby={headingId}>
      <h2 className="group-heading" id={headingId}>
        <button
          type="button"
          className="group-toggle"
          aria-expanded={!collapsed}
          aria-controls={listId}
          onClick={onToggle}
          title={plainText(shortenHome(group.key))}
        >
          <ChevronIcon />
          <span className="group-kind">
            {group.kind === 'git' ? <GitIcon /> : <FolderIcon />}
            <span className="visually-hidden">{group.kind === 'git' ? 'git repo' : 'directory'}</span>
          </span>
          <span className="group-label">
            <Highlight text={plainText(group.label)} />
          </span>
          {showRoot && <span className="group-root">in {plainText(shortenHome(group.root))}</span>}
          <span className="group-count">{count}</span>
          {attention > 0 && <span className="group-attention">{needYou(attention)}</span>}
        </button>
      </h2>
      <ul className="sessions" id={listId} hidden={collapsed}>
        {current.map((session) => (
          <SessionRow
            key={session.sessionId}
            session={session}
            groupKey={group.key}
            now={now}
            onOpen={onOpen}
            isOpen={session.sessionId === openSessionId}
          />
        ))}
        {finished.length > 0 && (
          <li className="finished-list">
            <button
              type="button"
              className="finished-toggle"
              aria-expanded={!finishedCollapsed}
              aria-controls={finishedId}
              onClick={onToggleFinished}
            >
              <ChevronIcon />
              Finished ({finished.length})
              {finishedAsked > 0 && <span className="finished-asked"> · {finishedAsked} asked you</span>}
            </button>
            <ul className="sessions finished-sessions" id={finishedId} hidden={finishedCollapsed}>
              {finished.map((session) => (
                <SessionRow
                  key={session.sessionId}
                  session={session}
                  groupKey={group.key}
                  now={now}
                  onOpen={onOpen}
                  isOpen={session.sessionId === openSessionId}
                />
              ))}
            </ul>
          </li>
        )}
      </ul>
    </section>
  );
}
