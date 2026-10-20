// The session list (docs/design-system.md, 3: Session list): the page alerts, then a header that
// stays put, with the selection's name, its summary and the filters, then the rows, which scroll.
// The rows are today's SessionRow, unchanged; two-line rows are W23's. A Finished section, collapsed
// by default, closes the list.

import { useId, type ReactNode, type RefObject } from 'react';
import type { SessionGroup } from '../../../src/shared/protocol.js';
import { plainText, shortenHome } from '../format.js';
import { needYou, sessionCount, type Listed } from '../sessions.js';
import { Icon } from './Icon.js';
import { ChevronIcon } from './icons.js';
import { SessionRow } from './SessionRow.js';

export interface SessionListHeading {
  /** The selection's name: a group's label, "Needs you" or "All sessions". */
  label: string;
  /** A group's kind, for its icon. */
  kind?: SessionGroup['kind'] | undefined;
  /** A group's root, shown as "in ~/work" when pitwall watches more than one. */
  root?: string | undefined;
}

export interface SessionListSummary {
  /** Every session in the selection, whatever the filters show. */
  total: number;
  /** How many the filters show. */
  shown: number;
  /** How many of the selection's sessions need you. */
  attention: number;
}

export interface SessionListProps {
  /** The page alerts, above the header. */
  alerts?: ReactNode;
  heading: SessionListHeading;
  /** For focus to land on the heading, as when a drawer item is chosen. */
  headingRef?: RefObject<HTMLHeadingElement | null>;
  /** Undefined before the first snapshot. */
  summary?: SessionListSummary | undefined;
  /** The filter field and chips, once there are sessions to filter. */
  filters?: ReactNode;
  current: readonly Listed[];
  finished: readonly Listed[];
  /** An empty, loading or no-match state, in place of the rows. */
  empty?: ReactNode;
  finishedCollapsed: boolean;
  onToggleFinished: () => void;
  now: number;
  onOpen?: ((sessionId: string) => void) | undefined;
  openSessionId?: string | undefined;
}

/** "4 sessions", or "2 of 4 sessions" while the filters hide some, then the need-you badge or "Nothing needs you". */
export function Summary({ total, shown, attention }: SessionListSummary) {
  return (
    <p className="summary">
      <span className="summary-count">{shown < total ? `${shown} of ${sessionCount(total)}` : sessionCount(total)}</span>
      {attention > 0 ? (
        <span className="badge badge-attention">{needYou(attention)}</span>
      ) : (
        <>
          <span aria-hidden="true">·</span>
          <span className="summary-calm">Nothing needs you</span>
        </>
      )}
    </p>
  );
}

export interface FinishedSectionProps {
  finished: readonly Listed[];
  collapsed: boolean;
  onToggle: () => void;
  now: number;
  onOpen?: ((sessionId: string) => void) | undefined;
  openSessionId?: string | undefined;
}

/** "Finished (n)", plus how many of them asked you something, over the finished rows. */
export function FinishedSection({ finished, collapsed, onToggle, now, onOpen, openSessionId }: FinishedSectionProps) {
  const listId = useId();
  // Counted here, so a question isn't hidden behind the collapse. Never as "need you".
  const asked = finished.reduce((count, { session }) => count + (session.askedYou ? 1 : 0), 0);
  return (
    <li className="finished-list">
      <button type="button" className="finished-toggle" aria-expanded={!collapsed} aria-controls={listId} onClick={onToggle}>
        <ChevronIcon />
        Finished ({finished.length})
        {asked > 0 && <span className="finished-asked"> · {asked} asked you</span>}
      </button>
      <ul className="sessions finished-sessions" id={listId} hidden={collapsed}>
        {finished.map(({ session, group }) => (
          <SessionRow key={session.sessionId} session={session} groupKey={group.key} now={now} onOpen={onOpen} isOpen={session.sessionId === openSessionId} />
        ))}
      </ul>
    </li>
  );
}

export function SessionList({
  alerts,
  heading,
  headingRef,
  summary,
  filters,
  current,
  finished,
  empty,
  finishedCollapsed,
  onToggleFinished,
  now,
  onOpen,
  openSessionId,
}: SessionListProps) {
  const headingId = useId();
  return (
    <main className="session-list" aria-labelledby={headingId}>
      {alerts && <div className="session-list-alerts">{alerts}</div>}
      <div className="session-list-head">
        <div className="session-list-title-row">
          <h2 className="session-list-title" id={headingId} ref={headingRef} tabIndex={-1}>
            {heading.kind && <Icon name={heading.kind === 'git' ? 'repo' : 'directory'} className="session-list-kind" />}
            <span className="session-list-label">{plainText(heading.label)}</span>
            {heading.kind && <span className="visually-hidden">, {heading.kind === 'git' ? 'git repo' : 'directory'}</span>}
            {heading.root && <span className="session-list-root">in {plainText(shortenHome(heading.root))}</span>}
          </h2>
          {summary && <Summary {...summary} />}
        </div>
        {filters && <div className="session-list-filters">{filters}</div>}
      </div>
      <div className="session-list-body">
        {empty ?? (
          <ul className="sessions">
            {current.map(({ session, group }) => (
              <SessionRow key={session.sessionId} session={session} groupKey={group.key} now={now} onOpen={onOpen} isOpen={session.sessionId === openSessionId} />
            ))}
            {finished.length > 0 && (
              <FinishedSection
                finished={finished}
                collapsed={finishedCollapsed}
                onToggle={onToggleFinished}
                now={now}
                onOpen={onOpen}
                openSessionId={openSessionId}
              />
            )}
          </ul>
        )}
      </div>
    </main>
  );
}
