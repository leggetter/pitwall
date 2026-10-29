// The session list (docs/design-system.md, 3: Session list): the page alerts, then a header that
// stays put, with the selection's name, its summary, a group's Hide from repo list button, the
// filters and the Sort setting, then the two-line rows, each with its star toggle (W53), which
// scroll, and a Finished section, collapsed by default, at the end. Ended interactive sessions are in
// it too (W67), and Show older, at its foot, lists those older than ENDED_SHOWN_DAYS.
//
// The rows come sorted. While the pointer is over the list or focus is inside it, a snapshot that
// would reorder them waits until both have left, so nothing moves under the reader; rows that are
// added or removed apply at once, and every row updates in place.
//
// A row is a piece of work (W106, work.ts): a session's, with the open PRs it owns, or a PR's that no
// session owns (PrRow.tsx), each in the order the sort gives. The Pull requests view is this list too,
// with its own filters, notices over the rows and a foot after them (PrList.tsx).

import { useEffect, useId, useRef, useState, type FocusEvent, type ReactNode, type RefObject } from 'react';
import { ENDED_SHOWN_DAYS, type PullRequestSummary, type SessionGroup, type SessionSummary } from '../../../src/shared/protocol.js';
import { plainText } from '../format.js';
import type { NotNeeded } from '../notNeeded.js';
import { prKey } from '../prs.js';
import { holdOrder, needYou, sessionCount, type Listed } from '../sessions.js';
import { isPrRow, rowKey, type ListRow } from '../work.js';
import { Button } from './Button.js';
import { Icon } from './Icon.js';
import { PrRow } from './PrRow.js';
import { ScrollBox } from './ScrollBox.js';
import { SessionRow } from './SessionRow.js';

export interface SessionListHeading {
  /** The selection's name: a group's label, "Needs you" or "All sessions". */
  label: string;
  /** A group's kind, for its icon. With several roots, the open root tab says which root it's under (W38). */
  kind?: SessionGroup['kind'] | undefined;
  /** A repo with no clone under the root (W106): its own icon, and "not cloned" after its name. */
  notCloned?: boolean | undefined;
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
  /** Notices over the rows, as the Pull requests view's about a fetch that failed (W106). */
  notices?: ReactNode;
  /** After the rows, as the Pull requests view's Show older and hidden line (W106). Not with an empty state. */
  foot?: ReactNode;
  /** More classes for the list's <main>: the Pull requests view's `pr-list`. */
  className?: string;
  /** The rows: sessions', and PRs' that no session owns (W106). */
  current: readonly ListRow[];
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
  /** The starred sessions' ids, for each row's star toggle (W53). */
  starred?: ReadonlySet<string> | undefined;
  /** Stars or unstars a session from its row. Rows have no star toggle without it. */
  onStar?: ((sessionId: string, on: boolean) => void) | undefined;
  /** The viewer's Not needed now marks (W88), for each row. */
  notNeeded?: NotNeeded | undefined;
  /** Marks a session not needed now from its row, or takes the mark away. Rows have no Not needed now toggle without it. */
  onNotNeeded?: ((session: SessionSummary, on: boolean) => void) | undefined;
  /** Covered by the session view over the list: nothing in it can take focus or a click (Dashboard.tsx). */
  inert?: boolean;
  /**
   * Show older, at the foot of the Finished section, while the selection has ended sessions older than
   * ENDED_SHOWN_DAYS (W67). The section shows for it even when none of its rows is shown.
   */
  older?: OlderEnded | undefined;
  /** The open PRs each session owns, most urgent first (W106, work.ts), for its row's PR badge, its attention and its line 2. */
  owned?: ReadonlyMap<string, readonly PullRequestSummary[]> | undefined;
  /** Opens a PR row's PR in the third column (W106). PR rows' titles aren't buttons without it. */
  onOpenPr?: ((key: string) => void) | undefined;
  /** ↑ or ↓ on a PR row's title: the next or previous row in the list as shown. */
  onStepPr?: ((key: string, by: 1 | -1) => void) | undefined;
  /** The open PR's key, whose row is marked open. */
  openPrKey?: string | undefined;
}

/**
 * "4 sessions", or "2 of 4 sessions" while the filters hide some, then the need-you badge or "Nothing
 * needs you". The count keeps the room its widest filtered form takes, "4 of 4 sessions" in tabular
 * numbers, in data-room, which CSS draws unseen behind it, so turning a filter on can't wrap the
 * heading's line and move what's below it (W75).
 */
export function Summary({ total, shown, attention }: SessionListSummary) {
  return (
    <p className="summary">
      <span className="summary-count" data-room={`${total} of ${sessionCount(total)}`}>
        <span>{shown < total ? `${shown} of ${sessionCount(total)}` : sessionCount(total)}</span>
      </span>
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

/** The rows' name buttons, a session's or a PR's title (W106), in the order shown, without those in a collapsed Finished section. */
const rowButtons = (list: HTMLElement) => [...list.querySelectorAll<HTMLElement>('[data-open-session], [data-open-pr]')].filter((button) => !button.closest('[hidden]'));

/** The row a name button opens, as rowKey() names it. */
const buttonRow = (button: HTMLElement) => button.dataset.openSession ?? `pr:${button.dataset.openPr ?? ''}`;

/** A row's own control that can have focus: its name's button, its star toggle (W53), or its Not needed now toggle (W88). */
type RowPart = 'open' | 'star' | 'not-needed';

/** Each toggle's data attribute, which holds its session's id. */
const PART_SELECTOR: Readonly<Record<Exclude<RowPart, 'open'>, string>> = { star: '[data-star-session]', 'not-needed': '[data-not-needed-session]' };

/** The control in `row`'s row that's `part`, or its name's button when it has no such control. */
function partOf(row: HTMLElement, part: RowPart): HTMLElement {
  return (part === 'open' ? null : row.closest('li.session')?.querySelector<HTMLElement>(PART_SELECTOR[part])) ?? row;
}

/** Which of its row's controls `target` is, and its row's key (rowKey()), or undefined for anything else. */
function rowPart(target: HTMLElement | undefined): { part: RowPart; id: string } | undefined {
  if (target?.dataset.starSession !== undefined) return { part: 'star', id: target.dataset.starSession };
  if (target?.dataset.notNeededSession !== undefined) return { part: 'not-needed', id: target.dataset.notNeededSession };
  if (target?.dataset.openSession !== undefined || target?.dataset.openPr !== undefined) return { part: 'open', id: buttonRow(target) };
  return undefined;
}

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, index) => id === b[index]);

/**
 * `items` in the order last shown while `holding`, with any that have gone left out and any new ones
 * in their place (holdOrder). Otherwise, or when `key` changes, in the order given.
 */
function useHeldOrder<T extends ListRow>(items: readonly T[], holding: boolean, key: string): readonly T[] {
  const ids = items.map(rowKey);
  const [shown, setShown] = useState(() => ({ key, ids }));
  const next = holding && shown.key === key ? holdOrder(shown.ids, ids) : ids;
  // Remembered from this render for the next one, as React suggests for state from earlier renders.
  if (shown.key !== key || !sameIds(shown.ids, next)) setShown({ key, ids: next });
  if (sameIds(next, ids)) return items;
  const byId = new Map(items.map((item) => [rowKey(item), item]));
  return next.flatMap((id) => byId.get(id) ?? []);
}

/**
 * Show older (W67): the selection's ended sessions last active more than ENDED_SHOWN_DAYS ago, and the
 * page's one switch for them, which isn't kept across reloads.
 */
export interface OlderEnded {
  /** How many of the selection's ended sessions are that old, as the filters show them. */
  count: number;
  /** Whether Show older is on: they're listed, and the button hides them again. */
  shown: boolean;
  onToggle: () => void;
}

/** The button's label: "Show 3 older sessions", or "Hide older sessions" once they're shown. */
export const olderText = (count: number, shown: boolean) => (shown ? 'Hide older sessions' : `Show ${count} older ${count === 1 ? 'session' : 'sessions'}`);

/** The line after it, which describes it: which sessions are older. */
export const OLDER_NOTE = `Ended more than ${ENDED_SHOWN_DAYS} days ago`;

export interface FinishedSectionProps {
  finished: readonly Listed[];
  collapsed: boolean;
  onToggle: () => void;
  showGroup?: boolean;
  onOpen?: ((sessionId: string) => void) | undefined;
  onStep?: ((sessionId: string, by: 1 | -1) => void) | undefined;
  openSessionId?: string | undefined;
  starred?: ReadonlySet<string> | undefined;
  onStar?: ((sessionId: string, on: boolean) => void) | undefined;
  notNeeded?: NotNeeded | undefined;
  onNotNeeded?: ((session: SessionSummary, on: boolean) => void) | undefined;
  /** Show older, after the rows, while the selection has older ended sessions (W67). */
  older?: OlderEnded | undefined;
}

/**
 * "Finished (n)", plus how many of them asked you something, over the finished rows; then, while the
 * selection has ended sessions older than ENDED_SHOWN_DAYS, Show older, which lists them, or Hide older
 * once they're listed. It's the same button with its other name, so focus stays on it.
 */
export function FinishedSection({ finished, collapsed, onToggle, showGroup = false, onOpen, onStep, openSessionId, starred, onStar, notNeeded, onNotNeeded, older }: FinishedSectionProps) {
  const listId = useId();
  const olderNoteId = useId();
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
            starred={starred?.has(session.sessionId) ?? false}
            onStar={onStar}
            notNeeded={notNeeded}
            onNotNeeded={onNotNeeded}
          />
        ))}
        {older && older.count > 0 && (
          <li className="finished-older">
            <Button size="sm" aria-describedby={olderNoteId} onClick={older.onToggle} data-older-toggle="">
              {olderText(older.count, older.shown)}
            </Button>
            <span className="finished-older-note" id={olderNoteId}>
              {OLDER_NOTE}
            </span>
          </li>
        )}
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
  notices,
  foot,
  className,
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
  starred,
  onStar,
  notNeeded,
  onNotNeeded,
  inert = false,
  older,
  owned,
  onOpenPr,
  onStepPr,
  openPrKey,
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
  // the one before it if it was last, or else the list's heading, rather than to the page. So does a
  // row unstarred in Starred (W53), from its star toggle: focus goes to the star toggle of the row
  // that took its place, so the next can be unstarred too; and a row marked not needed now in Needs
  // you (W88), whose focus goes to the next row's Not needed now toggle.
  const focusedRow = useRef<{ id: string; index: number; part: RowPart } | undefined>(undefined);
  useEffect(() => {
    if (!focusInside || main.current?.contains(document.activeElement)) return;
    const was = focusedRow.current;
    const active = document.activeElement;
    const lost = active === null || active === document.body;
    const rows = main.current ? rowButtons(main.current) : [];
    if (lost && was !== undefined && !rows.some((row) => buttonRow(row) === was.id)) {
      const row = rows[Math.min(was.index, rows.length - 1)];
      const next = (row && partOf(row, was.part)) ?? headingRef?.current ?? undefined;
      if (next) {
        next.focus();
        return;
      }
    }
    setFocusInside(false);
  });

  const onFocusIn = (event: FocusEvent<HTMLElement>) => {
    setFocusInside(true);
    const found = rowPart(event.target instanceof HTMLElement ? event.target : undefined);
    const index = found === undefined || !main.current ? -1 : rowButtons(main.current).findIndex((button) => buttonRow(button) === found.id);
    focusedRow.current = found !== undefined && index >= 0 ? { ...found, index } : undefined;
  };

  const onBlur = (event: FocusEvent<HTMLElement>) => {
    if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setFocusInside(false);
  };

  return (
    <main
      ref={main}
      className={className ? `session-list ${className}` : 'session-list'}
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
            {heading.kind && <Icon name={heading.notCloned ? 'external' : heading.kind === 'git' ? 'repo' : 'directory'} className="session-list-kind" />}
            <span className="session-list-label">{plainText(heading.label)}</span>
            {heading.kind && <span className="visually-hidden">, {heading.notCloned ? 'not cloned' : heading.kind === 'git' ? 'git repo' : 'directory'}</span>}
            {heading.notCloned && (
              <span className="session-list-not-cloned" aria-hidden="true">
                Not cloned
              </span>
            )}
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
        {notices}
        {empty ?? (
          <ul className="sessions">
            {shownCurrent.map((row) =>
              isPrRow(row) ? (
                <PrRow
                  key={rowKey(row)}
                  pr={row.pr}
                  group={row.group}
                  showGroup={showGroup}
                  isOpen={prKey(row.pr) === openPrKey}
                  onOpen={onOpenPr}
                  onStep={onStepPr}
                  older={row.older === true}
                />
              ) : (
                <SessionRow
                  key={row.session.sessionId}
                  session={row.session}
                  group={row.group}
                  showGroup={showGroup}
                  onOpen={onOpen}
                  onStep={onStep}
                  isOpen={row.session.sessionId === openSessionId}
                  starred={starred?.has(row.session.sessionId) ?? false}
                  onStar={onStar}
                  notNeeded={notNeeded}
                  onNotNeeded={onNotNeeded}
                  owned={owned?.get(row.session.sessionId)}
                />
              ),
            )}
            {(shownFinished.length > 0 || (older !== undefined && older.count > 0)) && (
              <FinishedSection
                finished={shownFinished}
                collapsed={finishedCollapsed}
                onToggle={onToggleFinished}
                showGroup={showGroup}
                onOpen={onOpen}
                onStep={onStep}
                openSessionId={openSessionId}
                starred={starred}
                onStar={onStar}
                notNeeded={notNeeded}
                onNotNeeded={onNotNeeded}
                older={older}
              />
            )}
          </ul>
        )}
        {empty === undefined && foot}
      </div>
    </main>
  );
}
