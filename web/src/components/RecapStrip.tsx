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
// - **The picture** (W150), for a recap that has one (recapPicture()): "Goal:", why it was started;
//   "Working on:", the item it's on and why; "Plan:", the plan's line, with Show plan, a disclosure
//   for the plan status panel under it; "For you (n):", only your to-dos, or "Nothing left to do."
//   with none at all; and a quiet "Waiting on CI." (or someone else, or another session). The
//   session's, CI's and someone else's to-dos aren't shown: what's next is the conversation's.
//   Collapsed: "Working on" on one line with an ellipsis, its whole in a tooltip when it's cut, and
//   "2 for you" after it.
// - **A recap without one** (stored before W150, or Claude Code's): the summary, always shown, then,
//   while it's open, every to-do in order, each with its owner as a small tag, and Plan status, a
//   text button for the same panel. Collapsed, the summary's first line and "2 for you". Claude
//   Code's recap has a summary only, so it has nothing to open, and Plan status sits under it.
// - **The plan status panel** (W123, planStatus.ts), under its button: the plan's one line, its items
//   in order, each tagged Done, Now, Next or Dropped, and how the plan changed; its age, Make a new one
//   and Close; "No plan found in this session." when there's none.
// - **While the first is on its way,** the strip's line 1 at once, so the tabs don't move twice, and
//   skeleton bars after --pw-delay-spinner; "No recap yet." once none is coming, with why when pitwall
//   can say; and "Couldn't load the recap." with Try again when fetching it failed.
//
// No strip with recaps off, or for a session pitwall can't recap, with no transcript it can read; an
// ended session has one, made when its view asks (D26). Nothing in it is a
// live region, so a snapshot that changes it announces nothing; Refresh's results are toasts. Every
// text from the recap is plain text, in <bdi>, since it names files, PRs and people.

import { useContext, useEffect, useId, useRef, useState, type ReactNode, type Ref } from 'react';
import type { PlanItem, PlanStatus, RecapHealth, RecapTodo, SessionRecap, SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext } from '../api.js';
import { plainText } from '../format.js';
import {
  forYouLabel,
  forYouText,
  GOAL_LABEL,
  NO_PLAN_LINE,
  NOTHING_LEFT_TEXT,
  PLAN_LABEL,
  recapPicture,
  REFRESH_RECAP_BUSY,
  REFRESH_RECAP_LABEL,
  TODO_OWNER_TEXT,
  todoOwnerLook,
  todosForYou,
  useRecap,
  useRecapCollapsed,
  waitingLineText,
  WORKING_ON_LABEL,
  type RecapController,
  type RecapPicture,
} from '../recap.js';
import type { StorageSource } from '../groupState.js';
import {
  NO_PLAN_TEXT,
  PLAN_CHANGES_LABEL,
  PLAN_STATE_TEXT,
  PLAN_STATUS_BUSY,
  PLAN_STATUS_CLOSE,
  PLAN_STATUS_HINT,
  PLAN_STATUS_LABEL,
  PLAN_STATUS_READY,
  PLAN_STATUS_REMAKE,
  planStateLook,
  SHOW_PLAN_LABEL,
  usePlanStatus,
  type PlanPanelState,
  type PlanStatusController,
} from '../planStatus.js';
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
  /** Whether the conversation's newest page says the turn has ended, for asking as the view opens (W132). */
  turnEnded?: boolean;
}

export function RecapStrip({ session, health, listed, hidden = false, storage, turnEnded }: RecapStripProps) {
  const api = useContext(ApiContext);
  const toast = useToast();
  const ref = useRef<HTMLElement>(null);
  const recap = useRecap({ api, session, health, listed, hidden, toast, delayFrom: () => ref.current, ...(turnEnded === undefined ? {} : { turnEnded }) });
  const [collapsed, setCollapsed] = useRecapCollapsed(storage);
  const plan = usePlanStatus({ api, session, health, listed, hidden });
  const planButton = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  const goalId = useId();
  const bodyId = useId();
  const planId = useId();
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
  const panel = (
    <PlanPanel
      plan={plan}
      id={planId}
      onClose={() => {
        plan.close();
        planButton.current?.focus();
      }}
    />
  );

  return (
    <section ref={ref} className="session-recap" aria-labelledby={headingId} data-recap={state.kind} data-collapsed={openable ? collapsed : undefined} data-plan={plan.open ? 'open' : undefined} data-picture={picture ? '' : undefined}>
      <div className="recap-head">
        <h3 className="recap-heading" id={headingId}>
          {openable ? (
            <button type="button" className="recap-toggle" aria-expanded={open} aria-controls={picture ? `${goalId} ${bodyId}` : bodyId} onClick={() => setCollapsed(!collapsed)}>
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
          goalId={goalId}
          bodyId={bodyId}
          showPlan={<PlanStatusButton plan={plan} controls={planId} buttonRef={planButton} label={SHOW_PLAN_LABEL} />}
          panel={panel}
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

      {/* A recap without the picture: its to-dos while it's open, then Plan status in the body (W150). */}
      {openable && !picture && (
        <div className="recap-body" id={bodyId} hidden={!open}>
          {shown ? (
            <>
              {shown.todos.length > 0 ? <Todos todos={shown.todos} /> : <p className="recap-note">{NOTHING_LEFT_TEXT}</p>}
              <p className="recap-plan-action">
                <PlanStatusButton plan={plan} controls={planId} buttonRef={planButton} label={PLAN_STATUS_LABEL} />
              </p>
              {panel}
            </>
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

      {/* No recap yet, it couldn't be loaded, or one is loading with no summary to show: Plan status still works, since it needs no recap, and an open panel stays put (W150's reviews). */}
      {!shown && (state.kind === 'none' || state.kind === 'failed' || (state.kind === 'loading' && !openable)) && (
        <>
          <p className="recap-plan-action">
            <PlanStatusButton plan={plan} controls={planId} buttonRef={planButton} label={PLAN_STATUS_LABEL} />
          </p>
          {panel}
        </>
      )}

      {/* Claude Code's recap has nothing to open: Plan status sits under its summary. */}
      {shown && !openable && (
        <>
          <p className="recap-plan-action">
            <PlanStatusButton plan={plan} controls={planId} buttonRef={planButton} label={PLAN_STATUS_LABEL} />
          </p>
          {panel}
        </>
      )}
    </section>
  );
}

/**
 * The picture (W150): "Goal:" while it's open; "Working on:", always, on one line with an ellipsis and
 * "2 for you" while it's collapsed; then, while it's open, "Plan:" with Show plan and the plan status
 * panel under it, "For you (n):" with only your to-dos, or "Nothing left to do." with none at all, and
 * a quiet line for what else it waits on.
 */
function Picture({
  recap,
  picture,
  open,
  goalId,
  bodyId,
  showPlan,
  panel,
}: {
  recap: SessionRecap;
  picture: RecapPicture;
  open: boolean;
  goalId: string;
  bodyId: string;
  showPlan: ReactNode;
  panel: ReactNode;
}) {
  const yours = recap.todos.filter((todo) => todo.owner === 'you');
  const waitingLine = waitingLineText(recap.waitingOn);
  return (
    <>
      <p className="recap-line" data-line="goal" id={goalId} hidden={!open}>
        <span className="recap-label">{GOAL_LABEL}</span> <bdi className="recap-line-text">{picture.goal}</bdi>
      </p>
      <Tooltip content={picture.workingOn} relation="none" onlyIfCut>
        <p className="recap-line recap-working-on" data-line="working-on">
          <span className="recap-label">{WORKING_ON_LABEL}</span>{' '}
          <span className="recap-line-text">
            <bdi>{picture.workingOn}</bdi>
          </span>
          {!open && yours.length > 0 && (
            <>
              <span className="visually-hidden">. </span>
              <Badge look="subtle-warning" className="recap-for-you">
                {forYouText(yours.length)}
              </Badge>
            </>
          )}
        </p>
      </Tooltip>
      <div className="recap-body" id={bodyId} hidden={!open}>
        <p className="recap-line" data-line="plan">
          <span className="recap-label">{PLAN_LABEL}</span> <bdi className="recap-line-text">{picture.plan === '' ? NO_PLAN_LINE : picture.plan}</bdi> {showPlan}
        </p>
        {panel}
        {yours.length > 0 ? (
          <div className="recap-line" data-line="for-you">
            <span className="recap-label">{forYouLabel(yours.length)}</span>
            <Todos todos={yours} tags={false} label="For you" />
          </div>
        ) : (
          recap.todos.length === 0 && <p className="recap-note">{NOTHING_LEFT_TEXT}</p>
        )}
        {waitingLine !== undefined && <p className="recap-note recap-waiting">{waitingLine}</p>}
      </div>
    </>
  );
}

/**
 * Plan status (W123), "Show plan" on the picture's Plan line (W150): a ghost sm text button, a
 * disclosure for the panel, busy while one is made.
 */
function PlanStatusButton({ plan, controls, buttonRef, label }: { plan: PlanStatusController; controls: string; buttonRef: Ref<HTMLButtonElement>; label: string }) {
  return (
    <Tooltip content={plan.busy ? PLAN_STATUS_BUSY : PLAN_STATUS_HINT} relation="description">
      <button
        ref={buttonRef}
        type="button"
        className="button ghost sm recap-plan-button"
        aria-expanded={plan.open}
        aria-controls={controls}
        aria-busy={plan.busy || undefined}
        data-plan-status=""
        onClick={plan.toggle}
      >
        {plan.busy ? <Spinner size="button" /> : <Icon name="expand" className="chevron" />}
        {label}
      </button>
    </Tooltip>
  );
}

/**
 * The plan status panel (W123), under its button: its heading, age, Make a new one and
 * Close; then the plan's one line, its items in order with their states as small tags, and how the
 * plan changed; or why there's none. Every text from it is plain text, in <bdi>.
 */
function PlanPanel({ plan, id, onClose }: { plan: PlanStatusController; id: string; onClose: () => void }) {
  const headingId = useId();
  const { state } = plan;
  const shown = state.kind === 'shown' ? state.status : undefined;
  const said = useSaidOnce(state, plan.open);
  return (
    <div className="recap-plan" id={id} role="region" aria-labelledby={headingId} hidden={!plan.open} data-plan-state={plan.open ? state.kind : undefined}>
      {/* There from the start, empty: says once that it's ready, or why not, when Reading… ends; a newer one from a snapshot says nothing. */}
      <p className="visually-hidden" role="status" data-plan-said="">
        {said}
      </p>
      <div className="recap-plan-head">
        <h4 className="recap-plan-heading" id={headingId}>
          {PLAN_STATUS_LABEL}
        </h4>
        {shown && <Timestamp className="recap-age recap-plan-age" at={shown.at} />}
        <span className="recap-actions">
          <Tooltip content={plan.busy ? PLAN_STATUS_BUSY : PLAN_STATUS_REMAKE} relation={plan.busy ? 'description' : 'label'}>
            <button
              type="button"
              className="icon-button ghost sm recap-plan-remake"
              aria-label={PLAN_STATUS_REMAKE}
              aria-disabled={plan.busy || undefined}
              aria-busy={plan.busy || undefined}
              onClick={plan.remake}
            >
              {plan.busy ? <Spinner size="button" /> : <Icon name="retry" />}
            </button>
          </Tooltip>
          <Tooltip content={PLAN_STATUS_CLOSE} relation="label">
            <button type="button" className="icon-button ghost sm recap-plan-close" aria-label={PLAN_STATUS_CLOSE} onClick={onClose}>
              <Icon name="close" />
            </button>
          </Tooltip>
        </span>
      </div>
      {!plan.open ? null : state.kind === 'shown' ? (
        <PlanBody status={state.status} />
      ) : state.kind === 'error' ? (
        <p className="recap-note">
          <bdi>{state.message}</bdi>
        </p>
      ) : (
        <p className="recap-note">{state.kind === 'making' ? PLAN_STATUS_BUSY : 'Loading the plan status.'}</p>
      )}
    </div>
  );
}

/**
 * What the panel's live region says: "Plan status ready." or the error, once, when loading or making
 * ends, and nothing while it's under way, while it's closed, or when a shown one is replaced by a newer one.
 */
function useSaidOnce(state: PlanPanelState, open: boolean): string {
  const [said, setSaid] = useState('');
  const before = useRef(state.kind);
  useEffect(() => {
    const was = before.current;
    before.current = state.kind;
    if (!open || state.kind === 'loading' || state.kind === 'making') return setSaid('');
    if (was !== 'loading' && was !== 'making') return;
    setSaid(state.kind === 'shown' ? PLAN_STATUS_READY : state.message);
  }, [state, open]);
  return said;
}

function PlanBody({ status }: { status: PlanStatus }) {
  if (!status.found) return <p className="recap-note">{NO_PLAN_TEXT}</p>;
  return (
    <>
      {status.plan !== undefined && (
        <p className="recap-plan-line">
          <bdi>{plainText(status.plan)}</bdi>
        </p>
      )}
      <PlanItems items={status.items} />
      {status.changes !== undefined && (
        <p className="recap-plan-changes">
          <span className="recap-plan-changes-label">{PLAN_CHANGES_LABEL}</span> <bdi>{plainText(status.changes)}</bdi>
        </p>
      )}
    </>
  );
}

/** The items, in the plan's order, as a numbered list: each its text, then its state as a small tag. Now in full colour, Dropped struck through. */
function PlanItems({ items }: { items: PlanItem[] }) {
  return (
    <ol className="recap-plan-items" aria-label="Plan items">
      {items.map((item, index) => (
        <li className="recap-plan-item" key={index} data-state={item.state}>
          <span className="recap-plan-item-text">
            <bdi>{plainText(item.text)}</bdi>
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
