// The session list (docs/design-system.md, 3: Session list): the page alerts, then a header that
// stays put, with the selection's name, its summary, the filters and the Sort setting, then the
// two-line rows, which scroll, and a Finished section, collapsed by default, at the end.
//
// The rows come sorted. While the pointer is over the list or focus is inside it, a snapshot that
// would reorder them waits until both have left, so nothing moves under the reader; rows that are
// added or removed apply at once, and every row updates in place.

import { useEffect, useId, useRef, useState, type FocusEvent, type ReactNode, type RefObject } from 'react';
import type { SessionGroup } from '../../../src/shared/protocol.js';
import { plainText, shortenHome } from '../format.js';
import { holdOrder, needYou, sessionCount, type Listed } from '../sessions.js';
import { Icon } from './Icon.js';
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
  /** The filter field, the chips and the Sort setting, once there are sessions to filter. */
  filters?: ReactNode;
  current: readonly Listed[];
  finished: readonly Listed[];
  /** An empty, loading or no-match state, in place of the rows. */
  empty?: ReactNode;
  finishedCollapsed: boolean;
  onToggleFinished: () => void;
  /** Rows start line 2 with their group's label: in Needs you and All sessions. */
  showGroup?: boolean;
  /**
   * Whether a snapshot's new order waits while the reader is in the list: under Urgency and Recent.
   * Name order never moves as sessions change.
   */
  holdOrder?: boolean;
  /** The selection and the sort order. When it changes, the rows take the new order at once: the reader asked for it. */
  orderKey?: string;
  onOpen?: ((sessionId: string) => void) | undefined;
  /** ↑ or ↓ on a row's name: the next or previous row in the list as shown. */
  onStep?: ((sessionId: string, by: 1 | -1) => void) | undefined;
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

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, index) => id === b[index]);

/**
 * `items` in the order last shown while `holding`, with any that have gone left out and any new ones
 * in their place (holdOrder). Otherwise, or when `key` changes, in the order given.
 */
function useHeldOrder(items: readonly Listed[], holding: boolean, key: string): readonly Listed[] {
  const ids = items.map(({ session }) => session.sessionId);
  const [shown, setShown] = useState(() => ({ key, ids }));
  const next = holding && shown.key === key ? holdOrder(shown.ids, ids) : ids;
  // Remembered from this render for the next one, as React suggests for state from earlier renders.
  if (shown.key !== key || !sameIds(shown.ids, next)) setShown({ key, ids: next });
  if (sameIds(next, ids)) return items;
  const byId = new Map(items.map((item) => [item.session.sessionId, item]));
  return next.flatMap((id) => byId.get(id) ?? []);
}

export interface FinishedSectionProps {
  finished: readonly Listed[];
  collapsed: boolean;
  onToggle: () => void;
  showGroup?: boolean;
  onOpen?: ((sessionId: string) => void) | undefined;
  onStep?: ((sessionId: string, by: 1 | -1) => void) | undefined;
  openSessionId?: string | undefined;
}

/** "Finished (n)", plus how many of them asked you something, over the finished rows. */
export function FinishedSection({ finished, collapsed, onToggle, showGroup = false, onOpen, onStep, openSessionId }: FinishedSectionProps) {
  const listId = useId();
  // Counted here, so a question isn't hidden behind the collapse. Never as "need you".
  const asked = finished.reduce((count, { session }) => count + (session.askedYou ? 1 : 0), 0);
  return (
    <li className="finished-list">
      <button type="button" className="finished-toggle" aria-expanded={!collapsed} aria-controls={listId} onClick={onToggle}>
        <Icon name="expand" className="chevron" />
        Finished ({finished.length})
        {asked > 0 && <span className="finished-asked"> · {asked} asked you</span>}
      </button>
      <ul className="sessions finished-sessions" id={listId} hidden={collapsed}>
        {finished.map(({ session, group }) => (
          <SessionRow
            key={session.sessionId}
            session={session}
            group={group}
            showGroup={showGroup}
            onOpen={onOpen}
            onStep={onStep}
            isOpen={session.sessionId === openSessionId}
          />
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
  showGroup = false,
  holdOrder: holds = false,
  orderKey = '',
  onOpen,
  onStep,
  openSessionId,
}: SessionListProps) {
  const headingId = useId();
  const main = useRef<HTMLElement>(null);
  const [pointerInside, setPointerInside] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  const holding = holds && (pointerInside || focusInside);
  const shownCurrent = useHeldOrder(current, holding, orderKey);
  const shownFinished = useHeldOrder(finished, holding, orderKey);

  // A focused row that a snapshot removes takes focus with it, and no blur says so.
  useEffect(() => {
    if (focusInside && !main.current?.contains(document.activeElement)) setFocusInside(false);
  });

  const onBlur = (event: FocusEvent<HTMLElement>) => {
    if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setFocusInside(false);
  };

  return (
    <main
      ref={main}
      className="session-list"
      aria-labelledby={headingId}
      onPointerEnter={() => setPointerInside(true)}
      onPointerLeave={() => setPointerInside(false)}
      onFocus={() => setFocusInside(true)}
      onBlur={onBlur}
    >
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
            {shownCurrent.map(({ session, group }) => (
              <SessionRow
                key={session.sessionId}
                session={session}
                group={group}
                showGroup={showGroup}
                onOpen={onOpen}
                onStep={onStep}
                isOpen={session.sessionId === openSessionId}
              />
            ))}
            {shownFinished.length > 0 && (
              <FinishedSection
                finished={shownFinished}
                collapsed={finishedCollapsed}
                onToggle={onToggleFinished}
                showGroup={showGroup}
                onOpen={onOpen}
                onStep={onStep}
                openSessionId={openSessionId}
              />
            )}
          </ul>
        )}
      </div>
    </main>
  );
}
