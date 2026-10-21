// The session list (docs/design-system.md, 3: Session list): the page alerts, then a header that
// stays put, with the selection's name, its summary, a group's Hide from repo list button, the
// filters and the Sort setting, then the two-line rows, which scroll, and a Finished section,
// collapsed by default, at the end.
//
// The rows come sorted. While the pointer is over the list or focus is inside it, a snapshot that
// would reorder them waits until both have left, so nothing moves under the reader; rows that are
// added or removed apply at once, and every row updates in place.

import { useEffect, useId, useRef, useState, type FocusEvent, type ReactNode, type RefObject } from 'react';
import type { SessionGroup } from '../../../src/shared/protocol.js';
import { plainText } from '../format.js';
import { holdOrder, needYou, sessionCount, type Listed } from '../sessions.js';
import { Icon } from './Icon.js';
import { ScrollBox } from './ScrollBox.js';
import { SessionRow } from './SessionRow.js';

export interface SessionListHeading {
  /** The selection's name: a group's label, "Needs you" or "All sessions". */
  label: string;
  /** A group's kind, for its icon. With several roots, the open root tab says which root it's under (W38). */
  kind?: SessionGroup['kind'] | undefined;
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
  /** At the end of the heading's line, after the summary: a group's Hide from repo list, or Show in repo list (W35). */
  headingAction?: ReactNode;
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
  /** Covered by the session view over the list: nothing in it can take focus or a click (Dashboard.tsx). */
  inert?: boolean;
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

/** The rows' name buttons in the order shown, without those in a collapsed Finished section. */
const rowButtons = (list: HTMLElement) => [...list.querySelectorAll<HTMLElement>('[data-open-session]')].filter((button) => !button.closest('[hidden]'));

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
  headingAction,
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
  inert = false,
}: SessionListProps) {
  const headingId = useId();
  const main = useRef<HTMLElement>(null);
  const [pointerInside, setPointerInside] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  const holding = holds && (pointerInside || focusInside);
  const shownCurrent = useHeldOrder(current, holding, orderKey);
  const shownFinished = useHeldOrder(finished, holding, orderKey);

  // A focused row that a snapshot removes, such as a session that moved to the repos it worked in
  // (W34), takes focus with it, and no blur says so. Focus goes to the row that took its place, or
  // the one before it if it was last, or else the list's heading, rather than to the page.
  const focusedRow = useRef<{ id: string; index: number } | undefined>(undefined);
  useEffect(() => {
    if (!focusInside || main.current?.contains(document.activeElement)) return;
    const was = focusedRow.current;
    const active = document.activeElement;
    const lost = active === null || active === document.body;
    const rows = main.current ? rowButtons(main.current) : [];
    if (lost && was !== undefined && !rows.some((row) => row.dataset.openSession === was.id)) {
      const next = rows[Math.min(was.index, rows.length - 1)] ?? headingRef?.current ?? undefined;
      if (next) {
        next.focus();
        return;
      }
    }
    setFocusInside(false);
  });

  const onFocusIn = (event: FocusEvent<HTMLElement>) => {
    setFocusInside(true);
    const id = event.target instanceof HTMLElement ? event.target.dataset.openSession : undefined;
    if (id !== undefined && main.current) focusedRow.current = { id, index: rowButtons(main.current).indexOf(event.target as HTMLElement) };
    else focusedRow.current = undefined;
  };

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
      onFocus={onFocusIn}
      onBlur={onBlur}
      inert={inert || undefined}
    >
      {/* At most half the column, then it scrolls: a Tab stop while it does (ScrollBox). */}
      {alerts && (
        <ScrollBox className="session-list-alerts" label="Alerts">
          {alerts}
        </ScrollBox>
      )}
      <div className="session-list-head">
        <div className="session-list-title-row">
          <h2 className="session-list-title" id={headingId} ref={headingRef} tabIndex={-1}>
            {heading.kind && <Icon name={heading.kind === 'git' ? 'repo' : 'directory'} className="session-list-kind" />}
            <span className="session-list-label">{plainText(heading.label)}</span>
            {heading.kind && <span className="visually-hidden">, {heading.kind === 'git' ? 'git repo' : 'directory'}</span>}
          </h2>
          {headingAction ? (
            <div className="session-list-end">
              {summary && <Summary {...summary} />}
              {headingAction}
            </div>
          ) : (
            summary && <Summary {...summary} />
          )}
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
