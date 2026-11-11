// The recap strip (M5, W111, W121, W150; docs/design-system.md, 4: Recap strip): in the session view
// between its header and its tabs, on every tab, so it's there whatever the view shows (Phil agreed,
// 2026-10-29: "a collapsible strip in the session view between the header and the tabs, not in the
// terminal or the conversation"). Phil, 2026-10-29: "Can you give me a status update? Where are we?";
// 2026-11-02: "just an updated version of what we're working on... Then, what's next?"; and 2026-11-05
// (W150, the recap strip gives the picture): "give us a bit more direction on the current work items
// we're working through and why we're doing them. Leave the 'what's next' for the actual inline
// terminal conversation."
//
// - **Line 1:** the disclosure button, "Recap", or "Claude Code's recap" when only Claude Code's
//   `away_summary` is there, with aria-expanded; how old it is, then Refresh, an icon button, right
//   after the age, so it reads as the recap's own (W150), busy while a new one is coming and off,
//   saying why, while the day's budget is spent; then "May be out of date" while it's older than the
//   session's latest turn.
// - **The picture** (W150), for a recap that has one (recapPicture()), written since W189 (recaps a
//   cold reader can act on) for someone with no context: the summary, what the session is doing and
//   where it stands, first; then, while it's open, "Goal:", the outcome and why it matters; "Done:",
//   what's finished (W189); "Working on:", what's in progress; the Plan section (W172); "For you
//   (n):", your to-dos, written as questions; "Next:", everyone else's, each tagged with who acts
//   (W189; Phil, 2026-11-11: "what's next"), or "Nothing left to do." with none at all; and a quiet
//   "Waiting on CI." (or someone else, or another session). Collapsed: the summary on one line with
//   an ellipsis, its whole in a tooltip when it's cut, and "2 for you" after it.
// - **The Plan section** (W172, the plan is part of the recap; Phil, 2026-11-09: "it's probably better
//   as a section like the recap"): in the picture's body, so hidden while the strip is collapsed, and
//   only when the recap names a plan. It mirrors the strip's own head: a disclosure, "Plan", with the
//   plan's line on the same row, on one line with an ellipsis while it's collapsed, its whole in a
//   tooltip when it's cut, wrapping while it's open. Open, the plan's items in order, each tagged
//   Done, Now, Next or Dropped, then "Changes:" when the plan changed. Collapsed by default, and the
//   choice is kept, as the strip's is. A recap stored before W172 has the line and no items: then
//   "Plan" is a plain heading with nothing to open. W123's Plan status, its button and panel, are gone.
// - **A recap without the picture** (stored before W150, or Claude Code's): the summary, always shown,
//   then, while it's open, every to-do in order, each with its owner as a small tag. Collapsed, the
//   summary's first line and "2 for you". Claude Code's recap has a summary only, so it has nothing
//   to open. Neither has a plan.
// - **While the first is on its way,** the strip's line 1 at once, so the tabs don't move twice, and
//   skeleton bars after --pw-delay-spinner; "No recap yet." once none is coming, with why when pitwall
//   can say; and "Couldn't load the recap." with Try again when fetching it failed.
//
// No strip with recaps off, or for a session pitwall can't recap, with no transcript it can read; an
// ended session has one, made when its view asks (D26). Nothing in it is a
// live region, so a snapshot that changes it announces nothing; Refresh's results are toasts. Every
// text from the recap is plain text, in <bdi>, since it names files, PRs and people.

import { useContext, useId, useRef } from 'react';
import type { PlanItem, RecapHealth, RecapTodo, SessionRecap, SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext } from '../api.js';
import { plainText } from '../format.js';
import {
  forYouLabel,
  forYouText,
  DONE_LABEL,
  GOAL_LABEL,
  NEXT_LABEL,
  NOTHING_LEFT_TEXT,
  PLAN_CHANGES_LABEL,
  PLAN_LABEL,
  PLAN_STATE_TEXT,
  planStateLook,
  recapPicture,
  REFRESH_RECAP_BUSY,
  REFRESH_RECAP_LABEL,
  TODO_OWNER_TEXT,
  todoOwnerLook,
  todosForYou,
  usePlanCollapsed,
  useRecap,
  useRecapCollapsed,
  waitingLineText,
  WORKING_ON_LABEL,
  type RecapController,
  type RecapPicture,
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
  /** Where the collapsed choices, the strip's and its Plan section's, are kept; the browser's localStorage by default. */
  storage?: StorageSource;
  /** Whether the conversation's newest page says the turn has ended, for asking as the view opens (W132). */
  turnEnded?: boolean;
}

export function RecapStrip({ session, health, listed, hidden = false, storage, turnEnded }: RecapStripProps) {
  const api = useContext(ApiContext);
  const toast = useToast();
  const ref = useRef<HTMLElement>(null);
  const recap = useRecap({ api, session, health, listed, hidden, toast, delayFrom: () => ref.current, ...(turnEnded === undefined ? {} : { turnEnded }) });
  const [collapsed, setCollapsed] = useRecapCollapsed(storage);
  const [planCollapsed, setPlanCollapsed] = usePlanCollapsed(storage);
  const headingId = useId();
  const bodyId = useId();
  const { state } = recap;
  const waiting = useWaiting(ref, state.kind === 'loading');
  if (state.kind === 'off') return null;

  const shown = state.kind === 'shown' ? state.recap : undefined;
  const summary = state.kind === 'loading' ? state.summary : undefined;
  const source = shown?.source ?? summary?.source ?? 'pitwall';
  const at = shown?.at ?? summary?.at;
  const picture = shown === undefined ? undefined : recapPicture(shown);
  // Something under line 1 to open: pitwall's picture or to-dos, or its note that none are left, or,
  // while it loads, what it will have. Claude Code's says only where it is.
  const openable = source === 'pitwall' && (shown !== undefined || summary !== undefined);
  const open = openable && !collapsed;
  const title = RECAP_TITLES[source];

  return (
    <section ref={ref} className="session-recap" aria-labelledby={headingId} data-recap={state.kind} data-collapsed={openable ? collapsed : undefined} data-picture={picture ? '' : undefined}>
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
        {/* Right after the age, so it reads as the recap's own, not the plan's (W150). */}
        <RefreshButton recap={recap} />
        {recap.stale && at !== undefined && (
          <Badge look="outline" hint={STALE_RECAP_HINT} className="recap-stale">
            {STALE_LABEL}
          </Badge>
        )}
      </div>

      {shown && picture ? (
        <Picture
          recap={shown}
          picture={picture}
          open={open}
          bodyId={bodyId}
          planCollapsed={planCollapsed}
          onPlanCollapsed={setPlanCollapsed}
        />
      ) : shown ? (
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

      {/* A recap without the picture: its to-dos while it's open. */}
      {openable && !picture && (
        <div className="recap-body" id={bodyId} hidden={!open}>
          {shown ? (
            shown.todos.length > 0 ? <Todos todos={shown.todos} /> : <p className="recap-note">{NOTHING_LEFT_TEXT}</p>
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
 * The picture (W150; W189): the summary, what the session is doing, always, on one line with an
 * ellipsis and "2 for you" while it's collapsed; then, while it's open, "Goal:", "Done:" when the recap
 * has it, "Working on:", the Plan section (W172) when it names a plan, "For you (n):" with your to-dos,
 * "Next:" with the rest, each tagged with who acts, or "Nothing left to do." with none at all, and a
 * quiet line for what else it waits on.
 */
function Picture({
  recap,
  picture,
  open,
  bodyId,
  planCollapsed,
  onPlanCollapsed,
}: {
  recap: SessionRecap;
  picture: RecapPicture;
  open: boolean;
  bodyId: string;
  planCollapsed: boolean;
  onPlanCollapsed: (collapsed: boolean) => void;
}) {
  const yours = recap.todos.filter((todo) => todo.owner === 'you');
  const others = recap.todos.filter((todo) => todo.owner !== 'you');
  const waitingLine = waitingLineText(recap.waitingOn);
  return (
    <>
      <Summary recap={recap} collapsed={!open} />
      <div className="recap-body" id={bodyId} hidden={!open}>
        <p className="recap-line" data-line="goal">
          <span className="recap-label">{GOAL_LABEL}</span> <bdi className="recap-line-text">{picture.goal}</bdi>
        </p>
        {picture.done !== undefined && (
          <p className="recap-line" data-line="done">
            <span className="recap-label">{DONE_LABEL}</span> <bdi className="recap-line-text">{picture.done}</bdi>
          </p>
        )}
        <p className="recap-line" data-line="working-on">
          <span className="recap-label">{WORKING_ON_LABEL}</span> <bdi className="recap-line-text">{picture.workingOn}</bdi>
        </p>
        {picture.plan !== '' && <PlanSection picture={picture} collapsed={planCollapsed} onCollapsed={onPlanCollapsed} />}
        {yours.length > 0 && (
          <div className="recap-line" data-line="for-you">
            <span className="recap-label">{forYouLabel(yours.length)}</span>
            <Todos todos={yours} tags={false} label="For you" />
          </div>
        )}
        {others.length > 0 && (
          <div className="recap-line" data-line="next">
            <span className="recap-label">{NEXT_LABEL}</span>
            <Todos todos={others} label="Next" />
          </div>
        )}
        {recap.todos.length === 0 && <p className="recap-note">{NOTHING_LEFT_TEXT}</p>}
        {waitingLine !== undefined && <p className="recap-note recap-waiting">{waitingLine}</p>}
      </div>
    </>
  );
}

/**
 * The Plan section (W172): an h4 with the disclosure, "Plan", and the plan's line on the same row, one
 * line with an ellipsis while it's collapsed, its whole in a tooltip when it's cut, wrapping while it's
 * open; open, the items and, when the plan changed, "Changes:". With no items, "Plan" is a plain
 * heading and the line wraps, since there's nothing to open.
 */
function PlanSection({ picture, collapsed, onCollapsed }: { picture: RecapPicture; collapsed: boolean; onCollapsed: (collapsed: boolean) => void }) {
  const listId = useId();
  const items = picture.items ?? [];
  const openable = items.length > 0;
  const open = openable && !collapsed;
  return (
    <div className="recap-plan" data-line="plan" data-open={openable ? open : undefined}>
      <div className="recap-plan-head">
        <h4 className="recap-plan-heading">
          {openable ? (
            <button type="button" className="recap-toggle recap-plan-toggle" aria-expanded={open} aria-controls={listId} onClick={() => onCollapsed(!collapsed)}>
              <Icon name="expand" className="chevron" />
              {PLAN_LABEL}
            </button>
          ) : (
            <span className="recap-plan-title">{PLAN_LABEL}</span>
          )}
        </h4>
        <Tooltip content={picture.plan} relation="none" onlyIfCut>
          <p className="recap-plan-line">
            <bdi>{picture.plan}</bdi>
          </p>
        </Tooltip>
      </div>
      {openable && (
        <div className="recap-plan-body" id={listId} hidden={!open}>
          <PlanItems items={items} />
          {picture.changes !== undefined && (
            <p className="recap-plan-changes">
              <span className="recap-plan-changes-label">{PLAN_CHANGES_LABEL}</span> <bdi>{picture.changes}</bdi>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** The items, in the plan's order, as a numbered list: each its text, then its state as a small tag. Now in full colour, Dropped struck through. */
function PlanItems({ items }: { items: PlanItem[] }) {
  return (
    <ol className="recap-plan-items" aria-label="Plan items">
      {items.map((item, index) => (
        <li className="recap-plan-item" key={index} data-state={item.state}>
          <span className="recap-plan-item-text">
            <bdi>{item.text}</bdi>
          </span>
          <span className="visually-hidden">, </span>
          <Badge look={planStateLook(item.state)} className="recap-plan-state">
            {PLAN_STATE_TEXT[item.state]}
          </Badge>
        </li>
      ))}
    </ol>
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
 * ready, you" from visually hidden punctuation. The picture's For you list (W150) has yours only, so
 * no tags.
 */
function Todos({ todos, tags = true, label = 'To-dos' }: { todos: RecapTodo[]; tags?: boolean; label?: string }) {
  return (
    <ol className="recap-todos" aria-label={label}>
      {todos.map((todo, index) => (
        <li className="recap-todo" key={index} data-owner={todo.owner}>
          <span className="recap-todo-text">
            <bdi>{plainText(todo.text)}</bdi>
          </span>
          {tags && (
            <>
              <span className="visually-hidden">, </span>
              <Badge look={todoOwnerLook(todo.owner)} className="recap-owner">
                {TODO_OWNER_TEXT[todo.owner]}
              </Badge>
            </>
          )}
        </li>
      ))}
    </ol>
  );
}

/** Refresh: a ghost sm icon button right after the age (W150), its spinner while a new recap is coming, off while the day's budget is spent, saying why. */
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
