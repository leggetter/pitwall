// The recap strip (M5, W111, W121; docs/design-system.md, 4: Recap strip): in the session view between
// its header and its tabs, on every tab, so it's there whatever the view shows (Phil agreed,
// 2026-10-29: "a collapsible strip in the session view between the header and the tabs, not in the
// terminal or the conversation"). Phil, 2026-10-29: "Can you give me a status update? Where are we?";
// and 2026-11-02: "just an updated version of what we're working on... Then, what's next? What are
// the outstanding actions? I'm not sure we need the breakdown."
//
// - **Line 1:** the disclosure button, "Recap", or "Claude Code's recap" when only Claude Code's
//   `away_summary` is there, with aria-expanded; how old it is, and "May be out of date" beside it
//   while it's older than the session's latest turn; and Refresh, an icon button, busy while a new
//   one is coming and off, saying why, while the day's budget is spent.
// - **The summary,** always shown: why it was started and where it is now. Collapsed, its first line
//   with an ellipsis, its whole in a tooltip when it's cut, and "2 for you" after it while any to-do
//   is yours.
// - **Then, while it's open:** the to-dos, in order, each with its owner as a small tag, yours in the
//   Needs you tone and your to-dos' text in full colour; or "Nothing left to do." with none. Claude
//   Code's recap has a summary only, so it has nothing to open.
// - **While the first is on its way,** the strip's line 1 at once, so the tabs don't move twice, and
//   skeleton bars after --pw-delay-spinner; "No recap yet." once none is coming, with why when pitwall
//   can say; and "Couldn't load the recap." with Try again when fetching it failed.
//
// No strip with recaps off, or for a session pitwall can't recap, with no transcript it can read; an
// ended session has one, made when its view asks (D26). Nothing in it is a
// live region, so a snapshot that changes it announces nothing; Refresh's results are toasts. Every
// text from the recap is plain text, in <bdi>, since it names files, PRs and people.

import { useContext, useId, useRef } from 'react';
import type { RecapHealth, RecapTodo, SessionRecap, SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext } from '../api.js';
import { plainText } from '../format.js';
import {
  forYouText,
  NOTHING_LEFT_TEXT,
  REFRESH_RECAP_BUSY,
  REFRESH_RECAP_LABEL,
  TODO_OWNER_TEXT,
  todoOwnerLook,
  todosForYou,
  useRecap,
  useRecapCollapsed,
  type RecapController,
} from '../recap.js';
import type { StorageSource } from '../groupState.js';
import { Badge } from './Badge.js';
import { Icon } from './Icon.js';
import { Spinner } from './Spinner.js';
import { Timestamp } from './Timestamp.js';
import { useToast } from './Toast.js';
import { Tooltip } from './Tooltip.js';
import { useWaiting } from './Waiting.js';

/** The badge on line 1 while the recap is older than the session's latest turn, and its hint. */
export const STALE_LABEL = 'May be out of date';
export const STALE_RECAP_HINT = "It's older than the session's latest turn.";

/** The strip's title, by where the recap came from. */
export const RECAP_TITLES: Readonly<Record<SessionRecap['source'], string>> = {
  pitwall: 'Recap',
  'claude-code': "Claude Code's recap",
};

export interface RecapStripProps {
  session: SessionSummary;
  /** The snapshot's RecapHealth: absent with recaps off, and then there's no strip. */
  health: RecapHealth | undefined;
  /** False once the session has left the snapshot: it shows what it had, and asks for nothing. */
  listed: boolean;
  /** In a root tab that isn't open (W38). */
  hidden?: boolean;
  /** Where the collapsed choice is kept; the browser's localStorage by default. */
  storage?: StorageSource;
}

export function RecapStrip({ session, health, listed, hidden = false, storage }: RecapStripProps) {
  const api = useContext(ApiContext);
  const toast = useToast();
  const ref = useRef<HTMLElement>(null);
  const recap = useRecap({ api, session, health, listed, hidden, toast, delayFrom: () => ref.current });
  const [collapsed, setCollapsed] = useRecapCollapsed(storage);
  const headingId = useId();
  const bodyId = useId();
  const { state } = recap;
  const waiting = useWaiting(ref, state.kind === 'loading');
  if (state.kind === 'off') return null;

  const shown = state.kind === 'shown' ? state.recap : undefined;
  const summary = state.kind === 'loading' ? state.summary : undefined;
  const source = shown?.source ?? summary?.source ?? 'pitwall';
  const at = shown?.at ?? summary?.at;
  // Something under the summary to open: pitwall's to-dos, or its note that none are left, or, while
  // it loads, the list it will have. Claude Code's says only where it is.
  const openable = source === 'pitwall' && (shown !== undefined || summary !== undefined);
  const open = openable && !collapsed;
  const title = RECAP_TITLES[source];

  return (
    <section ref={ref} className="session-recap" aria-labelledby={headingId} data-recap={state.kind} data-collapsed={openable ? collapsed : undefined}>
      <div className="recap-head">
        <h3 className="recap-heading" id={headingId}>
          {openable ? (
            <button type="button" className="recap-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setCollapsed(!collapsed)}>
              <Icon name="expand" className="chevron" />
              {title}
            </button>
          ) : (
            <span className="recap-title">{title}</span>
          )}
        </h3>
        {at !== undefined && <Timestamp className="recap-age" at={at} />}
        {recap.stale && at !== undefined && (
          <Badge look="outline" hint={STALE_RECAP_HINT} className="recap-stale">
            {STALE_LABEL}
          </Badge>
        )}
        <RefreshButton recap={recap} />
      </div>

      {shown ? (
        <Summary recap={shown} collapsed={openable && collapsed} />
      ) : state.kind === 'loading' ? (
        <>
          <span className="visually-hidden">Loading the recap</span>
          {waiting.shown && (
            <span className="recap-skeleton" aria-hidden="true">
              <span className="skeleton-bar recap-skeleton-summary" />
            </span>
          )}
        </>
      ) : state.kind === 'none' ? (
        <p className="recap-note">
          No recap yet.{state.why !== undefined && <> {state.why}</>}
        </p>
      ) : state.kind === 'failed' ? (
        <p className="recap-note">
          Couldn&apos;t load the recap{state.status === undefined ? '' : ` (HTTP ${state.status})`}.{' '}
          <button type="button" className="link-button" onClick={recap.retry}>
            Try again
          </button>
        </p>
      ) : null}

      {openable && (
        <div className="recap-body" id={bodyId} hidden={!open}>
          {shown ? (
            shown.todos.length > 0 ? (
              <Todos todos={shown.todos} />
            ) : (
              <p className="recap-note">{NOTHING_LEFT_TEXT}</p>
            )
          ) : (
            waiting.shown && (
              <span className="recap-skeleton" aria-hidden="true">
                <span className="skeleton-bar recap-skeleton-line" />
                <span className="skeleton-bar recap-skeleton-line short" />
              </span>
            )
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The summary: one paragraph, wrapping while the strip is open; collapsed, on one line with an
 * ellipsis, its whole in a tooltip when it's cut, and "2 for you" after it while any to-do is yours.
 */
function Summary({ recap, collapsed }: { recap: SessionRecap; collapsed: boolean }) {
  const text = plainText(recap.summary);
  const forYou = todosForYou(recap);
  return (
    <Tooltip content={text} relation="none" onlyIfCut>
      <p className="recap-summary">
        <span className="recap-summary-text">
          <bdi>{text}</bdi>
        </span>
        {collapsed && forYou > 0 && (
          <>
            <span className="visually-hidden">. </span>
            <Badge look="subtle-warning" className="recap-for-you">
              {forYouText(forYou)}
            </Badge>
          </>
        )}
      </p>
    </Tooltip>
  );
}

/**
 * The to-dos, in order, as a numbered list: each its text, then its owner as a small tag. Yours are
 * in the Needs you tone and full colour; the rest quiet. Screen readers hear "Say whether to mark #42
 * ready, you" from visually hidden punctuation.
 */
function Todos({ todos }: { todos: RecapTodo[] }) {
  return (
    <ol className="recap-todos" aria-label="To-dos">
      {todos.map((todo, index) => (
        <li className="recap-todo" key={index} data-owner={todo.owner}>
          <span className="recap-todo-text">
            <bdi>{plainText(todo.text)}</bdi>
          </span>
          <span className="visually-hidden">, </span>
          <Badge look={todoOwnerLook(todo.owner)} className="recap-owner">
            {TODO_OWNER_TEXT[todo.owner]}
          </Badge>
        </li>
      ))}
    </ol>
  );
}

/** Refresh: a ghost sm icon button, its spinner while a new recap is coming, off while the day's budget is spent, saying why. */
function RefreshButton({ recap }: { recap: RecapController }) {
  const { refreshing, refreshOff } = recap;
  const off = !refreshing && refreshOff !== undefined;
  const tip = refreshing ? REFRESH_RECAP_BUSY : (refreshOff ?? REFRESH_RECAP_LABEL);
  return (
    // Its name, always; while it's busy or off, the tooltip says why, and describes it.
    <Tooltip content={tip} relation={refreshing || off ? 'description' : 'label'}>
      <button
        type="button"
        className="icon-button ghost sm recap-refresh"
        aria-label={REFRESH_RECAP_LABEL}
        aria-disabled={refreshing || off || undefined}
        aria-busy={refreshing || undefined}
        data-recap-refresh=""
        onClick={() => {
          if (!refreshing && !off) recap.refresh();
        }}
      >
        {refreshing ? <Spinner size="button" /> : <Icon name="retry" />}
      </button>
    </Tooltip>
  );
}
