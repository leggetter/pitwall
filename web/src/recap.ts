// Recaps in the web UI (M5, W111, W121; docs/design-system.md, 4: Recap strip). A recap is a summary,
// why a session was started and where it is now, and its to-dos in order, each with who it waits on
// (spike 010; Phil, 2026-11-02). The snapshot carries what the list and Needs you need of each
// (SessionSummary.recap, D14); the session view fetches the whole of it with recapPath(), and asks for
// a new one with recapRefreshPath().
//
// What this module decides, for the strip (RecapStrip.tsx), the rows (SessionRow.tsx) and the app
// strip (AppStrip.tsx):
//
// - **When the view fetches:** recapPath() once the view is shown, and again whenever the snapshot's
//   `recap.at` changes. Only for a session that has a recap: one with none has nothing to fetch.
// - **When it asks for one:** once, as the view is first shown, after --pw-delay-attach, so a session
//   only passed through with j or k is never recapped, as it's never attached (W54), and only when
//   it's worth a call (W132, asksOnOpen()): when the session has no recap, or its recap is stale and
//   its turn has ended. Not while it works, since its recap would be stale again at the turn's end,
//   and the engine updates it 15 minutes after that (RECAP_UPDATE_DEBOUNCE_MS; 5 for a background
//   job that says it is done, W162). Never again by
//   itself, whatever arrives: Refresh is there for the rest. Not while the day's budget is spent,
//   which the snapshot says (RecapHealth).
// - **No strip** with recaps off (no `recaps` on the snapshot, or a 409), and for a session the server
//   says it can't recap (a 404): one with no transcript it can read. An ended session has one: it's
//   recapped when you ask (D26), and its view asks once as it opens, as any other's does.
// - **Refresh** POSTs recapRefreshPath(), and is busy until the snapshot's `recap.at` changes and the
//   new recap is fetched, or a stale one is current again, or for RECAP_WAIT_MS, or until a call fails
//   after it asked (RecapHealth's errorAt), which the app strip then says.
//   Off, saying why, while the day's budget is spent. Its other results are toasts, as Refresh for
//   the PR list has them.
//
// - **The picture** (W150, the recap strip gives the picture): a recap since W150 also has the goal,
//   what it's working on and why, and the plan's line (recapPicture()). The strip shows those, and of
//   the to-dos only yours, since what's next is the conversation's. One without them, stored before
//   W150 or Claude Code's own, shows its summary as before.
// - **The plan's items** (W172, the plan is part of the recap): since W172 the recap also has the
//   plan's items, each Done, Now, Next or Dropped, and how the plan changed, which the strip shows
//   as the picture's Plan section. W123's Plan status, a call of its own, is gone.
// - **For a cold reader** (W189, recaps a cold reader can act on; Phil, 2026-11-11: "I need it to tell
//   me what we're doing, what the goal is, why we're doing it, and what's next"): the summary, what
//   the session is doing, leads the picture, collapsed or open; then what's done, and every to-do:
//   yours under For you, as questions, and the rest under Next, each tagged with who acts.
//
// Only two things are stored, per viewer (D14): whether the strip is collapsed, and whether its Plan
// section is, each a boolean.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PLAN_ITEM_MAX,
  PLAN_ITEM_STATES,
  PLAN_ITEMS_MAX,
  RECAP_DAILY_BUDGET,
  RECAP_FIELD_MAX,
  RECAP_TODO_OWNERS,
  RECAP_TODOS_MAX,
  RECAP_WAITING_ON,
  recapPath,
  recapRefreshPath,
  type PlanItem,
  type PlanItemState,
  type RecapHealth,
  type RecapSummary,
  type RecapTodo,
  type RecapTodoOwner,
  type RecapWaitingOn,
  type SessionRecap,
  type SessionSummary,
} from '../../src/shared/protocol.js';
import type { ApiClient } from './api.js';
import { needsAttention, WAITING_ON_TEXT, waitingElsewhere, type BadgeLook } from './sessions.js';
import { couldNot, plainText } from './format.js';
import { browserStorage, type StorageSource } from './groupState.js';
import { ATTACH_DELAY_MS, cssTime } from './timing.js';
import { turnMode } from './working.js';
import type { ShowToast } from './components/Toast.js';

/** Whether the strip is collapsed: "true" or "false", nothing else (D14). */
export const RECAP_COLLAPSED_KEY = 'pitwall.recap-collapsed.v1';

/** Collapsed, as stored, or open when there's nothing stored, it can't be read, or it isn't "true". */
export function readRecapCollapsed(storage: StorageSource = browserStorage): boolean {
  try {
    return storage()?.getItem(RECAP_COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeRecapCollapsed(collapsed: boolean, storage: StorageSource = browserStorage): void {
  try {
    storage()?.setItem(RECAP_COLLAPSED_KEY, collapsed ? 'true' : 'false');
  } catch {
    // Blocked or full: the choice lasts until the page reloads.
  }
}

/** The choice, read once, and a setter that stores it. */
export function useRecapCollapsed(storage: StorageSource = browserStorage): [boolean, (collapsed: boolean) => void] {
  const [collapsed, setCollapsed] = useState(() => readRecapCollapsed(storage));
  const set = useCallback(
    (next: boolean) => {
      setCollapsed(next);
      writeRecapCollapsed(next, storage);
    },
    [storage],
  );
  return [collapsed, set];
}

/** Whether the picture's Plan section is collapsed (W172): "true" or "false", nothing else (D14). */
export const RECAP_PLAN_COLLAPSED_KEY = 'pitwall.recap-plan-collapsed.v1';

/** The Plan section's choice: collapsed unless "false" is stored, so it starts collapsed, and when it can't be read. */
export function readPlanCollapsed(storage: StorageSource = browserStorage): boolean {
  try {
    return storage()?.getItem(RECAP_PLAN_COLLAPSED_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function writePlanCollapsed(collapsed: boolean, storage: StorageSource = browserStorage): void {
  try {
    storage()?.setItem(RECAP_PLAN_COLLAPSED_KEY, collapsed ? 'true' : 'false');
  } catch {
    // Blocked or full: the choice lasts until the page reloads.
  }
}

/** The Plan section's choice (W172), read once, and a setter that stores it, as useRecapCollapsed() does the strip's. */
export function usePlanCollapsed(storage: StorageSource = browserStorage): [boolean, (collapsed: boolean) => void] {
  const [collapsed, setCollapsed] = useState(() => readPlanCollapsed(storage));
  const set = useCallback(
    (next: boolean) => {
      setCollapsed(next);
      writePlanCollapsed(next, storage);
    },
    [storage],
  );
  return [collapsed, set];
}

// What a session waits on, as line 2 and the badges say it: in sessions.ts, which statusBadge() is in.
export { WAITING_ON_TEXT } from './sessions.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/** At most `max` UTF-16 code units, without splitting a surrogate pair, with an ellipsis when cut. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** A to-do from recapPath()'s body: exactly a string text and a known owner, the text cut to RECAP_FIELD_MAX. */
function parseTodo(raw: unknown): RecapTodo | undefined {
  if (!isRecord(raw)) return undefined;
  const { text, owner, after } = raw;
  // W166's `after`, when there is one, is a third key; the page has no use for it.
  if (Object.keys(raw).length !== (after === undefined ? 2 : 3) || (after !== undefined && typeof after !== 'boolean')) return undefined;
  if (typeof text !== 'string' || typeof owner !== 'string' || !(RECAP_TODO_OWNERS as readonly string[]).includes(owner)) return undefined;
  return { text: cutText(text, RECAP_FIELD_MAX), owner: owner as RecapTodoOwner };
}

/** A plan item from recapPath()'s body (W172): exactly a string text and a known state, the text cut to PLAN_ITEM_MAX. */
function parsePlanItem(raw: unknown): PlanItem | undefined {
  if (!isRecord(raw) || Object.keys(raw).length !== 2) return undefined;
  const { text, state } = raw;
  if (typeof text !== 'string' || typeof state !== 'string' || !(PLAN_ITEM_STATES as readonly string[]).includes(state)) return undefined;
  return { text: cutText(text, PLAN_ITEM_MAX), state: state as PlanItemState };
}

/**
 * A recap from recapPath()'s body, read defensively: every field of SessionRecap with its type, a
 * known `waitingOn`, `source` and owner for each to-do, and times that are times; anything else is no
 * recap. The summary, each to-do and the title are cut to RECAP_FIELD_MAX, and the to-dos to
 * RECAP_TODOS_MAX, as the server should already have them. W150's goal, working on and plan are kept,
 * cut the same way, only when all three are text, with W189's done when it's text too; one that isn't text makes it no recap. W172's plan
 * items, each exactly a text and a known state, the first PLAN_ITEMS_MAX, and its changes are kept
 * with a plan's line; items that aren't that, or changes that aren't text, make it no recap.
 */
export function parseRecap(body: unknown): SessionRecap | undefined {
  if (!isRecord(body)) return undefined;
  const { summary, todos, waitingOn, title, at, throughAt, source, stale, goal, done, workingOn, plan, planItems, planChanges } = body;
  for (const field of [goal, done, workingOn, plan, planChanges]) if (field !== undefined && typeof field !== 'string') return undefined;
  if (planItems !== undefined && !Array.isArray(planItems)) return undefined;
  const items = planItems === undefined ? undefined : planItems.slice(0, PLAN_ITEMS_MAX).map(parsePlanItem);
  if (items?.some((item) => item === undefined)) return undefined;
  if (typeof summary !== 'string' || typeof title !== 'string' || !Array.isArray(todos)) return undefined;
  if (typeof waitingOn !== 'string' || !(RECAP_WAITING_ON as readonly string[]).includes(waitingOn)) return undefined;
  if (source !== 'pitwall' && source !== 'claude-code') return undefined;
  if (!isTime(at) || !isTime(throughAt)) return undefined;
  if (stale !== undefined && stale !== true) return undefined;
  const parsed = todos.slice(0, RECAP_TODOS_MAX).map(parseTodo);
  if (parsed.some((todo) => todo === undefined)) return undefined;
  const recap: SessionRecap = {
    summary: cutText(summary, RECAP_FIELD_MAX),
    todos: parsed as RecapTodo[],
    waitingOn: waitingOn as RecapWaitingOn,
    title: cutText(title, RECAP_FIELD_MAX),
    at,
    throughAt,
    source,
  };
  if (typeof goal === 'string' && typeof workingOn === 'string' && typeof plan === 'string') {
    recap.goal = cutText(goal, RECAP_FIELD_MAX);
    recap.workingOn = cutText(workingOn, RECAP_FIELD_MAX);
    recap.plan = cutText(plan, RECAP_FIELD_MAX);
    if (typeof done === 'string') recap.done = cutText(done, RECAP_FIELD_MAX);
    if (items !== undefined) recap.planItems = items as PlanItem[];
    if (typeof planChanges === 'string' && planChanges !== '') recap.planChanges = cutText(planChanges, RECAP_FIELD_MAX);
  }
  if (stale === true) recap.stale = true;
  return recap;
}

/** W150's picture of a recap: its goal, what it's working on and its plan's line, as plain text, and since W172 the plan's items and changes. */
export interface RecapPicture {
  goal: string;
  /** What's finished so far, plain (W189). Absent from a recap made before W189. */
  done?: string;
  workingOn: string;
  /** Empty when the recap names no plan: then there's no Plan section (W172). */
  plan: string;
  /** The plan's items, their texts plain (W172). Absent, or empty, for a plan with none: the section has nothing to open. */
  items?: PlanItem[];
  /** How the plan changed, plain (W172). Absent when it records no change. */
  changes?: string;
}

/**
 * The recap's picture (W150), when it's pitwall's and has one: a goal and a working on that aren't
 * empty once made plain, and a plan's line, which may be. Undefined for one stored before W150 and
 * for Claude Code's, which the strip shows as their summary.
 */
export function recapPicture(recap: SessionRecap): RecapPicture | undefined {
  if (recap.source !== 'pitwall' || recap.goal === undefined || recap.workingOn === undefined || recap.plan === undefined) return undefined;
  const goal = plainText(recap.goal).trim();
  const workingOn = plainText(recap.workingOn).trim();
  if (goal === '' || workingOn === '') return undefined;
  const plan = plainText(recap.plan).trim();
  const picture: RecapPicture = { goal, workingOn, plan };
  const done = recap.done === undefined ? '' : plainText(recap.done).trim();
  if (done !== '') picture.done = done;
  if (plan === '') return picture;
  const items = (recap.planItems ?? []).map(({ text, state }) => ({ text: plainText(text).trim(), state })).filter((item) => item.text !== '');
  if (items.length > 0) picture.items = items;
  const changes = recap.planChanges === undefined ? '' : plainText(recap.planChanges).trim();
  if (changes !== '') picture.changes = changes;
  return picture;
}

/** The picture's labels (W150). */
export const GOAL_LABEL = 'Goal:';
/** Before what's finished so far (W189). */
export const DONE_LABEL = 'Done:';
export const WORKING_ON_LABEL = 'Working on:';
/** Before the to-dos that aren't yours, each tagged with who acts (W189). */
export const NEXT_LABEL = 'Next:';
/** The Plan section's heading, a disclosure when it has items (W172). */
export const PLAN_LABEL = 'Plan';
/** Before the plan's changes, in its open section (W172). */
export const PLAN_CHANGES_LABEL = 'Changes:';
/** "For you (2):", before your to-dos. */
export const forYouLabel = (count: number) => `For you (${count.toLocaleString('en-US')}):`;

/** Each plan item's state as its tag says it (W123, W172). */
export const PLAN_STATE_TEXT: Readonly<Record<PlanItemState, string>> = {
  done: 'Done',
  now: 'Now',
  next: 'Next',
  dropped: 'Dropped',
};

/** A plan item's tag: Now in the info tone, Done in success's, Next quiet, Dropped an outline. */
export function planStateLook(state: PlanItemState): BadgeLook {
  switch (state) {
    case 'done':
      return 'subtle-success';
    case 'now':
      return 'subtle-info';
    case 'next':
      return 'subtle-neutral';
    case 'dropped':
      return 'outline';
  }
}

/**
 * The quiet line under the picture when the session waits on CI, someone else or another session
 * (W150): "Waiting on CI.". Undefined for you, whose to-dos are listed, and for nothing.
 */
export function waitingLineText(waitingOn: RecapWaitingOn): string | undefined {
  if (waitingOn === 'you' || waitingOn === 'nothing') return undefined;
  return `${WAITING_ON_TEXT[waitingOn]}.`;
}

/** A to-do's owner as its tag says it (W121). The session is "Session": the tag is a label, not a sentence. */
export const TODO_OWNER_TEXT: Readonly<Record<RecapTodoOwner, string>> = {
  you: 'You',
  session: 'Session',
  CI: 'CI',
  'someone else': 'Someone else',
};

/** A to-do's tag: yours in the Needs you tone, subtle warning, as Asked you is; the rest quiet. */
export function todoOwnerLook(owner: RecapTodoOwner): BadgeLook {
  return owner === 'you' ? 'subtle-warning' : 'subtle-neutral';
}

/** How many of a recap's to-dos are yours. */
export function todosForYou(recap: Pick<SessionRecap, 'todos'>): number {
  return recap.todos.filter((todo) => todo.owner === 'you').length;
}

/** The collapsed strip's count of your to-dos: "1 for you", "2 for you". */
export const forYouText = (count: number) => `${count.toLocaleString('en-US')} for you`;

/** The strip's note when pitwall's recap has no to-dos. */
export const NOTHING_LEFT_TEXT = 'Nothing left to do.';

/** Whether the day's recap budget is spent, by the snapshot (RecapHealth). */
export function budgetSpent(health: RecapHealth | undefined): boolean {
  return health !== undefined && health.calls >= health.budget;
}

/** Ends `text` with a full stop when it doesn't end a sentence already. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Refresh's tooltip, and the info toast after a 429, while the budget is spent. */
export const budgetText = (budget: number) => `Today's ${budget} recaps are used up, so pitwall makes no more until midnight.`;

/** The info toast after a 409, and what the strip's absence means. */
export const RECAPS_OFF_TEXT = "Recaps are off: pitwall was started with --no-recaps, so it doesn't make them.";

/** The info toast after a 404 from Refresh. */
export const NOT_RECAPPED_TEXT = "pitwall can't recap this session: it has no transcript pitwall can read.";

/** Refresh's name and tooltip, and its tooltip while busy. */
export const REFRESH_RECAP_LABEL = 'Refresh the recap';
export const REFRESH_RECAP_BUSY = 'Making a new recap. It takes a few seconds.';

/** The error toast after any other failure. */
export const refreshRecapFailedText = (status: number | undefined) => `${couldNot('refresh the recap', status)} Try again in a moment.`;

/**
 * The app strip's line about recaps (W111), or undefined while they're fine or off: the day's budget
 * spent, first, since nothing more is made today whatever went wrong; else the latest call's error, in
 * pitwall's words, never the model's.
 */
export function recapsStripText(health: RecapHealth | undefined): string | undefined {
  if (!health) return undefined;
  if (budgetSpent(health)) return `${budgetText(health.budget)} Each session keeps its last recap.`;
  const error = health.error === undefined ? '' : plainText(health.error).trim();
  if (error !== '') return `The latest recap failed: ${sentence(error)} Each session keeps its last recap until one works.`;
  return undefined;
}

/**
 * What an idle session's current recap says it's waiting on, when it isn't you or nothing: "Waiting
 * on CI", "Waiting on another session" or "Waiting on someone else", for a quiet reason on its row's
 * line 2. Never counts as needing you. Not while it works, needs you or has ended, and not from a
 * recap older than its latest turn, nor from Claude Code's, which says nothing of what it waits on.
 */
export function quietWaitingOn(session: SessionSummary, needsYou: boolean): string | undefined {
  const waiting = waitingElsewhere(session);
  if (waiting === undefined || needsYou) return undefined;
  if (session.status === 'busy' || (session.alive && session.state === 'working')) return undefined;
  // A done job's badge says it already, in Done's place (W170).
  if (session.state === 'done') return undefined;
  return WAITING_ON_TEXT[waiting];
}

/**
 * The PR the session view names after its badge (W170): the one its job's own file links, while its
 * recap says it waits on someone else, CI or another session, as waitingPr() has it. `owner/name#n`, and its GitHub address.
 * The index takes the repo and number only from an exact PR URL (src/index/jobs.ts), so the address
 * is one.
 */
export function waitingPrLink(session: SessionSummary): { text: string; url: string } | undefined {
  const pr = session.jobPr;
  // When the row's line 2 would name it: not while it needs you, nor while it works (W170's review).
  if (pr === undefined || waitingPr(session, needsAttention(session)) === undefined) return undefined;
  return { text: `${pr.repo}#${pr.number}`, url: `https://github.com/${pr.repo}/pull/${pr.number}` };
}

/**
 * The pull request a session waiting on someone else, on CI or on another session waits on, as line 2
 * names it, "#6089" (W170): the one its job's own file links (SessionSummary.jobPr); the session view
 * names its repo too. None while it needs you, while it works, unless its job is done, and while the
 * row shows that PR's own badge already (`shown`, the open PRs it owns).
 */
export function waitingPr(session: SessionSummary, needsYou: boolean, shown: readonly { repo: string; number: number }[] = []): string | undefined {
  const pr = session.jobPr;
  if (pr === undefined || needsYou || waitingElsewhere(session) === undefined) return undefined;
  if (session.state !== 'done' && (session.status === 'busy' || (session.alive && session.state === 'working'))) return undefined;
  if (shown.some((owned) => owned.repo.toLowerCase() === pr.repo && owned.number === pr.number)) return undefined;
  return `#${pr.number}`;
}

/**
 * The first of your to-dos in a session's current recap, pitwall's, and how many it has (W161): what a
 * row that needs you through a PR alone says on line 2, "For you (3): …", rather than the PR's state.
 * None from a recap older than its latest turn, which may have been answered since.
 */
export function recapForYou(session: SessionSummary): { next: string; count: number } | undefined {
  const recap = session.recap;
  if (!recap || recap.stale || recap.source !== 'pitwall' || recap.forYou < 1) return undefined;
  const next = recap.next?.trim();
  return next === undefined || next === '' ? undefined : { next, count: recap.forYou };
}

/**
 * Whether a finished or ended session's current recap, pitwall's, says it's waiting on you (W111's
 * review): its row and view show an outline "Waiting on you", as a finished session's Asked you is,
 * with FINISHED_RECAP_HINT or ENDED_RECAP_HINT, and it never counts as needing you, since the index
 * never puts a finished session in Needs you. Not where it shows a finished Asked you already.
 */
export function finishedWaitingOnYou(session: SessionSummary): boolean {
  const recap = session.recap;
  if (!session.finished || session.askedYou !== undefined || !recap) return false;
  return recap.source === 'pitwall' && recap.waitingOn === 'you' && recap.stale !== true;
}

export const FINISHED_RECAP_HINT = "Its recap says it's waiting on you. It has finished, so it isn't counted as needing you.";
export const ENDED_RECAP_HINT = "Its recap says it's waiting on you. It has ended, so it isn't counted as needing you.";

/** How long Refresh stays busy waiting for the new recap: spike 010's calls took 3 to 7 s, plus the poll's 5. */
export const RECAP_WAIT_MS = 60_000;

/** What the strip shows. */
export type RecapStripState =
  /** No strip: recaps are off, or pitwall can't recap the session, which has no transcript it can read. */
  | { kind: 'off' }
  /** Nothing to show yet: the first is on its way, or the snapshot's summary is all there is so far. */
  | { kind: 'loading'; summary?: RecapSummary }
  | { kind: 'shown'; recap: SessionRecap }
  /** None, and none on its way: `why` when pitwall can say. */
  | { kind: 'none'; why?: string }
  /** Fetching it failed, with nothing to show. */
  | { kind: 'failed'; status?: number };

export interface RecapController {
  state: RecapStripState;
  /** Older than the session's latest turn, by the snapshot's summary, or the recap's own word without one. */
  stale: boolean;
  /** A refresh is asked for, out, or waiting for its recap. */
  refreshing: boolean;
  /** Why Refresh is off, or undefined while it's on. */
  refreshOff: string | undefined;
  /** Refresh: asks for a new recap now. Does nothing while one is coming or Refresh is off. */
  refresh: () => void;
  /** Try again, after a failed fetch: fetches the recap again. */
  retry: () => void;
}

export interface UseRecapOptions {
  api: ApiClient | undefined;
  session: SessionSummary;
  /** The snapshot's RecapHealth: absent with recaps off. */
  health: RecapHealth | undefined;
  /** False once the session has left the snapshot: nothing more is asked for. */
  listed: boolean;
  /** In a root tab that isn't open (W38): nothing is fetched or asked for until it's shown. */
  hidden: boolean;
  /** Where Refresh's results go. */
  toast: ShowToast;
  /** The element the strip is in, for --pw-delay-attach. */
  delayFrom?: () => Element | null | undefined;
  /**
   * Whether the conversation's newest page says the turn has ended (ConversationPage.turnEnded), as
   * the working line reads it: Claude Code's status alone can say busy with no turn running.
   */
  turnEnded?: boolean;
}

/**
 * Whether the strip asks for a recap as the view opens (W132): when the session has none, or its
 * recap is stale and its turn has ended, by the working line's rule (turnMode()). Not while it works:
 * a recap made then is stale at the turn's end, and the engine makes the next one by itself.
 */
export function asksOnOpen(session: SessionSummary, listed: boolean, turnEnded: boolean | undefined): boolean {
  const summary = session.recap;
  if (summary === undefined) return true;
  return summary.stale === true && turnMode(session, listed, turnEnded) !== 'working';
}

type Phase = 'idle' | 'queued' | 'asking' | 'awaiting';

/** The toast key Refresh's results share, so a second replaces the first. */
const TOAST_KEY = 'recap-refresh';

/** The recap behind one session's strip: what to show, and Refresh. See the top of this file for when it fetches and asks. */
export function useRecap({ api, session, health, listed, hidden, toast, delayFrom, turnEnded }: UseRecapOptions): RecapController {
  const { sessionId } = session;
  const summary = session.recap;
  const summaryAt = summary?.at;
  // Ended sessions too (D26): one has a recap once you ask, and the view asks once as it opens, as for any other.
  const enabled = api !== undefined && health !== undefined;

  const [fetched, setFetched] = useState<SessionRecap>();
  // The latest fetch's outcome, for the summary it was for.
  const [got, setGot] = useState<{ for: string; status: 'loading' | 'done' | 'missing' | 'failed'; code?: number }>();
  const [refused, setRefused] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  // Whether the open-time decision, to ask for one or not, has been made.
  const [decided, setDecided] = useState(false);
  const [retries, setRetries] = useState(0);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const healthRef = useRef(health);
  healthRef.current = health;
  const summaryRef = useRef(summary);
  summaryRef.current = summary;
  const toastRef = useRef(toast);
  toastRef.current = toast;
  // What a refresh waits for: a summary other than this one, or this stale one made current, or an error set after this time.
  const awaited = useRef<{ fromAt: string | undefined; fromStale: boolean; askedAtMs: number }>({ fromAt: undefined, fromStale: false, askedAtMs: 0 });

  // The whole recap, once the view is shown, and again whenever the snapshot's `recap.at` changes.
  const tried = useRef<string | undefined>(undefined);
  const fetchedAt = fetched?.at;
  useEffect(() => {
    if (!enabled || hidden || !api || summaryAt === undefined) return;
    if (fetchedAt === summaryAt || tried.current === summaryAt) return;
    tried.current = summaryAt;
    const controller = new AbortController();
    let done = false;
    setGot({ for: summaryAt, status: 'loading' });
    void api.get(recapPath(sessionId), { signal: controller.signal }).then((result) => {
      done = true;
      if (controller.signal.aborted || !alive.current) return;
      if (result.kind === 'ok') {
        const recap = parseRecap(result.body);
        if (recap) {
          setFetched(recap);
          setGot({ for: summaryAt, status: 'done' });
        } else setGot({ for: summaryAt, status: 'failed', code: result.status });
        return;
      }
      if (result.kind === 'unauthorized') return;
      setGot(result.status === 404 ? { for: summaryAt, status: 'missing' } : { for: summaryAt, status: 'failed', ...(result.status === undefined ? {} : { code: result.status }) });
    });
    return () => {
      controller.abort();
      // Cut short, as when the view is hidden meanwhile: fetched again once it's shown.
      if (!done) tried.current = undefined;
    };
  }, [enabled, hidden, api, summaryAt, fetchedAt, sessionId, retries]);

  const post = useCallback(
    (auto: boolean) => {
      if (!api || phaseRef.current === 'asking' || phaseRef.current === 'awaiting') return;
      setPhase('asking');
      awaited.current = { fromAt: summaryRef.current?.at, fromStale: summaryRef.current?.stale === true, askedAtMs: Date.now() };
      void api.post(recapRefreshPath(sessionId), {}).then((result) => {
        if (!alive.current) return;
        const say = (tone: 'info' | 'error', message: string) => {
          if (!auto) toastRef.current({ tone, key: TOAST_KEY, message });
        };
        if (result.kind === 'ok') return setPhase('awaiting');
        setPhase('idle');
        // The connection was refused, and the page says so in place of the dashboard.
        if (result.kind === 'unauthorized') return;
        if (result.status === 429) {
          // Which 429 the server says it is, since a budget shared with another pitwall can be spent
          // before this snapshot says so; without a word, by the snapshot.
          const current = healthRef.current;
          const busy = isRecord(result.body) ? result.body.busy : undefined;
          if (busy === 'spent' || (busy !== 'running' && budgetSpent(current))) return say('info', budgetText(current?.budget ?? RECAP_DAILY_BUDGET));
          // A call for it is already running, so its recap is on its way.
          return setPhase('awaiting');
        }
        if (result.status === 409 || result.status === 404) {
          setRefused(true);
          return say('info', result.status === 409 ? RECAPS_OFF_TEXT : NOT_RECAPPED_TEXT);
        }
        say('error', refreshRecapFailedText(result.status));
      });
    },
    [api, sessionId],
  );

  // Once, as the view is first shown: none, or a stale recap once the turn has ended, asks for one
  // (asksOnOpen()), after --pw-delay-attach, by the session as it is then, since the conversation's
  // first page, which says whether the turn has ended, may come meanwhile. Hidden before then, as by a
  // root tab's switch, it decides again when it's shown.
  const stale = summary !== undefined ? summary.stale === true : fetched?.stale === true;
  const wanted = summary === undefined || summary.stale === true;
  const asks = useRef<() => boolean>(() => false);
  asks.current = () => asksOnOpen(session, listed, turnEnded);
  useEffect(() => {
    if (decided || !enabled || hidden || !listed) return;
    if (!wanted || budgetSpent(health)) {
      setDecided(true);
      return;
    }
    setPhase('queued');
    let fired = false;
    const timer = setTimeout(
      () => {
        fired = true;
        setDecided(true);
        if (asks.current()) post(true);
        else setPhase((current) => (current === 'queued' ? 'idle' : current));
      },
      cssTime(delayFrom?.() ?? undefined, '--pw-delay-attach', ATTACH_DELAY_MS),
    );
    return () => {
      clearTimeout(timer);
      if (!fired) setPhase((current) => (current === 'queued' ? 'idle' : current));
    };
    // Decided once: what changes after that, such as the summary going stale, doesn't ask again, so
    // `wanted`, `health` and `post` are read as they are when it's shown, not followed.
  }, [decided, enabled, hidden, listed]);

  // Waiting for the recap a refresh asked for: until the snapshot's summary changes and the new recap
  // has been fetched, or fetching it has failed, so Refresh isn't idle beside the old one; until a
  // stale recap is current again, as when the turns since it showed nothing new, so the engine moved
  // its throughAt and kept its at; until a call fails after the ask, by RecapHealth's errorAt, since an
  // error from before it stays until a call succeeds; or for RECAP_WAIT_MS.
  const errorAtMs = health?.error !== undefined && health.errorAt !== undefined ? Date.parse(health.errorAt) : NaN;
  const failedSince = errorAtMs >= awaited.current.askedAtMs;
  const madeCurrent = awaited.current.fromStale && summaryAt === awaited.current.fromAt && summary !== undefined && summary.stale !== true;
  const arrived = madeCurrent || (summaryAt !== awaited.current.fromAt && (fetchedAt === summaryAt || (got !== undefined && got.for === summaryAt && got.status !== 'loading')));
  useEffect(() => {
    if (phase !== 'awaiting') return;
    if (arrived || failedSince) {
      setPhase('idle');
      return;
    }
    const timer = setTimeout(() => setPhase((current) => (current === 'awaiting' ? 'idle' : current)), RECAP_WAIT_MS);
    return () => clearTimeout(timer);
  }, [phase, arrived, failedSince]);

  const spent = budgetSpent(health);
  const refreshing = phase !== 'idle';
  const refreshOff = !listed ? "It's no longer listed, so pitwall can't recap it." : spent && !refreshing ? budgetText(health?.budget ?? 0) : undefined;

  const refresh = useCallback(() => {
    if (!enabled || !listed || phaseRef.current !== 'idle' || budgetSpent(healthRef.current)) return;
    post(false);
  }, [enabled, listed, post]);

  const retry = useCallback(() => {
    tried.current = undefined;
    setRetries((count) => count + 1);
  }, []);

  let state: RecapStripState;
  // The latest fetch's outcome, while it's for the summary there is now.
  const current = got !== undefined && got.for === summaryAt ? got : undefined;
  if (!enabled || refused) state = { kind: 'off' };
  else if (fetched) state = { kind: 'shown', recap: fetched };
  else if (summary && current?.status !== 'missing') {
    state = current?.status === 'failed' ? { kind: 'failed', ...(current.code === undefined ? {} : { status: current.code }) } : { kind: 'loading', summary };
  } else if (refreshing || (!decided && listed && !hidden)) state = { kind: 'loading' };
  else {
    const error = health?.error === undefined ? '' : plainText(health.error).trim();
    const why = spent ? budgetText(health?.budget ?? 0) : error !== '' ? `The latest recap failed: ${sentence(error)}` : undefined;
    state = why === undefined ? { kind: 'none' } : { kind: 'none', why };
  }

  return { state, stale, refreshing, refreshOff, refresh, retry };
}
