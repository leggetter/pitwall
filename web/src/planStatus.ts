// Plan status in the web UI (M5, W123; docs/design-system.md, 4: Recap strip). Phil, 2026-11-02: "I
// want it to be clear that work is done as part of a plan... we're working our way through that
// plan. That plan can change." A button on the recap strip, beside Refresh, that shows where the
// session is in its bigger plan: the plan in one line, its items in order, each Done, Now, Next or
// Dropped, and how the plan changed, read from the transcript. Nothing is sent to the session.
//
// What this module decides, for the strip (RecapStrip.tsx):
//
// - **Pressed, it opens the panel** under the summary and the to-dos, and shows the newest plan
//   status: fetched with planStatusPath() when the snapshot says there's one (SessionSummary.
//   planStatusAt, D14), else made with planStatusRefreshPath(), which answers once the call has
//   finished. Pressed again, or the panel's Close, closes it. Nothing is fetched or made until then.
// - **Make a new one,** in the panel, POSTs again.
// - **While one is made** the button is busy, its spinner and aria-busy, and the panel says so.
// - **A newer one,** made in another tab, is fetched while the panel is open, when the snapshot's
//   planStatusAt changes.
// - **Why not:** the day's recap budget spent, by the snapshot or a 429; recaps off (a 409); no
//   transcript (a 404); the call failed (a 502, pitwall's words); anything else.
//
// Nothing is stored in the browser.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PLAN_ITEM_MAX,
  PLAN_ITEM_STATES,
  PLAN_ITEMS_MAX,
  planStatusPath,
  planStatusRefreshPath,
  RECAP_DAILY_BUDGET,
  RECAP_FIELD_MAX,
  type PlanItem,
  type PlanItemState,
  type PlanStatus,
  type RecapHealth,
  type SessionSummary,
} from '../../src/shared/protocol.js';
import type { ApiClient } from './api.js';
import { couldNot, plainText } from './format.js';
import { budgetSpent, budgetText, cutText } from './recap.js';
import type { BadgeLook } from './sessions.js';

/** The button's name, which Phil chose (2026-11-02), and the panel's heading. */
export const PLAN_STATUS_LABEL = 'Plan status';
/** The button's tooltip while a plan status is made, and the panel's note meanwhile. */
export const PLAN_STATUS_BUSY = "Reading the session's plan from its transcript. It takes a few seconds.";
/** The panel's note when the transcript shows no plan. */
export const NO_PLAN_TEXT = 'No plan found in this session.';
/** The panel's Make a new one, and its Close. */
export const PLAN_STATUS_REMAKE = 'Make a new plan status';
export const PLAN_STATUS_CLOSE = 'Close the plan status';
/** Before the changes line. */
export const PLAN_CHANGES_LABEL = 'Changes:';

/** The panel's notes when none can be made. */
export const PLAN_OFF_TEXT = "Plan status is off: pitwall was started with --no-recaps, so it doesn't make one.";
export const PLAN_NO_TRANSCRIPT_TEXT = "pitwall can't read this session's plan: it has no transcript pitwall can read.";
export const PLAN_NOT_LISTED_TEXT = "It's no longer listed, so pitwall can't read its plan.";
export const planFailedText = (status: number | undefined) => `${couldNot('make the plan status', status)} Try again in a moment.`;
export const planLoadFailedText = (status: number | undefined) => `${couldNot('load the plan status', status)} Try again in a moment.`;

/** An item's state as its tag says it. */
export const PLAN_STATE_TEXT: Readonly<Record<PlanItemState, string>> = {
  done: 'Done',
  now: 'Now',
  next: 'Next',
  dropped: 'Dropped',
};

/** An item's tag: Now in the info tone, Done in success's, Next quiet, Dropped an outline. */
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function parseItem(raw: unknown): PlanItem | undefined {
  if (!isRecord(raw) || Object.keys(raw).length !== 2) return undefined;
  const { text, state } = raw;
  if (typeof text !== 'string' || typeof state !== 'string' || !(PLAN_ITEM_STATES as readonly string[]).includes(state)) return undefined;
  return { text: cutText(text, PLAN_ITEM_MAX), state: state as PlanItemState };
}

/**
 * A plan status from planStatusPath()'s body, or planStatusRefreshPath()'s `status`, read
 * defensively: `found` a boolean, times that are times, items each exactly a string text and a known
 * state; a found one with a plan and at least one item, one not found with neither. Texts are cut to
 * their limits, as the server should already have them. Anything else is no plan status.
 */
export function parsePlanStatus(body: unknown): PlanStatus | undefined {
  if (!isRecord(body)) return undefined;
  const { found, plan, items, changes, at, throughAt } = body;
  if (typeof found !== 'boolean' || !isTime(at) || !isTime(throughAt) || !Array.isArray(items)) return undefined;
  if (!found) return items.length === 0 && plan === undefined && changes === undefined ? { found: false, items: [], at, throughAt } : undefined;
  if (typeof plan !== 'string' || items.length === 0 || (changes !== undefined && typeof changes !== 'string')) return undefined;
  const parsed = items.slice(0, PLAN_ITEMS_MAX).map(parseItem);
  if (parsed.some((item) => item === undefined)) return undefined;
  const status: PlanStatus = { found: true, plan: cutText(plan, RECAP_FIELD_MAX), items: parsed as PlanItem[], at, throughAt };
  if (changes !== undefined && changes !== '') status.changes = cutText(changes, RECAP_FIELD_MAX);
  return status;
}

/** What the panel shows. */
export type PlanPanelState =
  | { kind: 'loading' }
  /** Being made: by this page, or, after a 429 'running', by another. */
  | { kind: 'making' }
  | { kind: 'shown'; status: PlanStatus }
  /** None, and why, in pitwall's words. */
  | { kind: 'error'; message: string };

export interface PlanStatusController {
  /** Whether the panel is open. */
  open: boolean;
  /** What it shows while open. */
  state: PlanPanelState;
  /** A plan status is being made: the button is busy. */
  busy: boolean;
  /** The button: opens the panel, fetching or making one, or closes it. */
  toggle: () => void;
  /** The panel's Close. */
  close: () => void;
  /** Make a new one: does nothing while one is being made. */
  remake: () => void;
}

export interface UsePlanStatusOptions {
  api: ApiClient | undefined;
  session: SessionSummary;
  /** The snapshot's RecapHealth, for the budget. */
  health: RecapHealth | undefined;
  /** False once the session has left the snapshot: nothing new is made. */
  listed: boolean;
  /** In a root tab that isn't open (W38): nothing is fetched until it's shown. */
  hidden: boolean;
}

/** How long the panel waits for a plan status another request is making, after a 429 'running'. */
export const PLAN_WAIT_MS = 90_000;

/** The plan status behind one session's Plan status button. See the top of this file. */
export function usePlanStatus({ api, session, health, listed, hidden }: UsePlanStatusOptions): PlanStatusController {
  const { sessionId } = session;
  const flagAt = session.planStatusAt;
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<PlanPanelState>({ kind: 'loading' });
  const [shown, setShown] = useState<PlanStatus>();
  const [making, setMaking] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const healthRef = useRef(health);
  healthRef.current = health;
  const makingRef = useRef(making);
  makingRef.current = making;
  // Waiting for one another request is making (a 429 'running'): the snapshot's flag before it.
  const [waitingFrom, setWaitingFrom] = useState<{ at: string | undefined } | undefined>();

  const show = useCallback((status: PlanStatus) => {
    setShown(status);
    setState({ kind: 'shown', status });
  }, []);

  const make = useCallback(() => {
    if (!api || makingRef.current) return;
    if (!listed) return setState({ kind: 'error', message: PLAN_NOT_LISTED_TEXT });
    if (budgetSpent(healthRef.current)) return setState({ kind: 'error', message: budgetText(healthRef.current?.budget ?? RECAP_DAILY_BUDGET) });
    setMaking(true);
    makingRef.current = true;
    setState({ kind: 'making' });
    void api.post(planStatusRefreshPath(sessionId), {}).then((result) => {
      if (!alive.current) return;
      setMaking(false);
      makingRef.current = false;
      if (result.kind === 'unauthorized') return;
      if (result.kind === 'ok') {
        const status = isRecord(result.body) ? parsePlanStatus(result.body.status) : undefined;
        return status ? show(status) : setState({ kind: 'error', message: planFailedText(result.status) });
      }
      const body = isRecord(result.body) ? result.body : {};
      if (result.status === 429) {
        if (body.busy === 'running') {
          setWaitingFrom({ at: flagAt });
          return setState({ kind: 'making' });
        }
        return setState({ kind: 'error', message: budgetText(healthRef.current?.budget ?? RECAP_DAILY_BUDGET) });
      }
      if (result.status === 409) return setState({ kind: 'error', message: PLAN_OFF_TEXT });
      if (result.status === 404) return setState({ kind: 'error', message: PLAN_NO_TRANSCRIPT_TEXT });
      // The call failed: the server's reason is pitwall's own words, shown as plain text.
      if (result.status === 502 && typeof body.error === 'string' && plainText(body.error).trim() !== '') {
        return setState({ kind: 'error', message: cutText(plainText(body.error).trim(), RECAP_FIELD_MAX) });
      }
      setState({ kind: 'error', message: planFailedText(result.status) });
    });
  }, [api, listed, sessionId, flagAt, show]);

  // Fetches the newest one, and makes one when there's none after all.
  const fetchLatest = useCallback(
    (signal: AbortSignal, orMake: boolean) => {
      if (!api) return;
      setState((current) => (current.kind === 'shown' ? current : { kind: 'loading' }));
      void api.get(planStatusPath(sessionId), { signal }).then((result) => {
        if (signal.aborted || !alive.current) return;
        if (result.kind === 'unauthorized') return;
        if (result.kind === 'ok') {
          const status = parsePlanStatus(result.body);
          return status ? show(status) : setState({ kind: 'error', message: planLoadFailedText(result.status) });
        }
        if (result.status === 404 && orMake) return make();
        setState({ kind: 'error', message: planLoadFailedText(result.status) });
      });
    },
    [api, sessionId, show, make],
  );

  // While it's open: the snapshot's flag says there's one newer than what it has, made here or in
  // another tab, or the one a 429 'running' was waiting for. Fetched once per value of the flag, so
  // an answer older than the flag doesn't fetch again; not aborted when it re-renders, since the
  // answer is kept either way.
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const waitingRef = useRef(waitingFrom);
  waitingRef.current = waitingFrom;
  const fetchedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!open || hidden || flagAt === undefined || makingRef.current || fetchedFor.current === flagAt) return;
    const have = shownRef.current;
    const waiting = waitingRef.current;
    if (have !== undefined && Date.parse(have.at) >= Date.parse(flagAt)) return;
    if (have === undefined && waiting === undefined) return;
    if (waiting !== undefined && waiting.at === flagAt) return;
    fetchedFor.current = flagAt;
    setWaitingFrom(undefined);
    fetchLatest(new AbortController().signal, false);
  }, [open, hidden, flagAt, making, fetchLatest]);

  // Waiting for another request's plan status gives up after PLAN_WAIT_MS.
  useEffect(() => {
    if (waitingFrom === undefined) return;
    const timer = setTimeout(() => {
      setWaitingFrom(undefined);
      setState((current) => (current.kind === 'making' ? { kind: 'error', message: planFailedText(undefined) } : current));
    }, PLAN_WAIT_MS);
    return () => clearTimeout(timer);
  }, [waitingFrom]);

  const opening = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => opening.current?.abort(), []);

  const toggle = useCallback(() => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (makingRef.current || waitingFrom !== undefined) return;
    if (shown !== undefined && (flagAt === undefined || Date.parse(shown.at) >= Date.parse(flagAt))) return show(shown);
    if (flagAt !== undefined) {
      opening.current?.abort();
      opening.current = new AbortController();
      fetchedFor.current = flagAt;
      return fetchLatest(opening.current.signal, true);
    }
    make();
  }, [open, shown, flagAt, waitingFrom, show, fetchLatest, make]);

  const close = useCallback(() => setOpen(false), []);
  const remake = useCallback(() => {
    if (!makingRef.current && waitingFrom === undefined) make();
  }, [make, waitingFrom]);

  return { open, state, busy: making || waitingFrom !== undefined, toggle, close, remake };
}
