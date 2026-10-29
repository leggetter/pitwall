// Recaps in the web UI (M5, W111; docs/design-system.md, 4: Recap strip). A recap says why a session
// was started, where it is now and what's next or what it's waiting on (spike 010). The snapshot
// carries a summary of each (SessionSummary.recap: what the list and Needs you need, D14); the session
// view fetches the whole of it with recapPath(), and asks for a new one with recapRefreshPath().
//
// What this module decides, for the strip (RecapStrip.tsx), the rows (SessionRow.tsx) and the app
// strip (AppStrip.tsx):
//
// - **When the view fetches:** recapPath() once the view is shown, and again whenever the snapshot's
//   `recap.at` changes. Only for a session that has a recap: one with none has nothing to fetch.
// - **When it asks for one:** once, as the view is first shown, when its recap is stale or it has
//   none, after --pw-delay-attach, so a session only passed through with j or k is never recapped,
//   as it's never attached (W54). Never again by itself, whatever arrives: the recap engine makes the
//   next one 5 minutes after a turn ends (W110), and Refresh is there for the rest. Not while the
//   day's budget is spent, which the snapshot says (RecapHealth).
// - **No strip** with recaps off (no `recaps` on the snapshot, or a 409), for an ended session, which
//   pitwall doesn't recap, and for one the server says it doesn't recap (a 404), such as its own.
// - **Refresh** POSTs recapRefreshPath(), and is busy until the snapshot's `recap.at` changes and the
//   new recap is fetched, or for
//   RECAP_WAIT_MS, or until a call fails, which the app strip then says. Off, saying why, while the
//   day's budget is spent. Its other results are toasts, as Refresh for the PR list has them.
//
// Only one thing is stored: whether the strip is collapsed, a boolean, per viewer (D14).

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RECAP_FIELD_MAX,
  RECAP_WAITING_ON,
  recapPath,
  recapRefreshPath,
  type RecapHealth,
  type RecapSummary,
  type RecapWaitingOn,
  type SessionRecap,
  type SessionSummary,
} from '../../src/shared/protocol.js';
import type { ApiClient } from './api.js';
import type { BadgeLook } from './sessions.js';
import { couldNot, plainText } from './format.js';
import { browserStorage, type StorageSource } from './groupState.js';
import { ATTACH_DELAY_MS, cssTime } from './timing.js';
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

/** What a session waits on, other than nothing, as the strip and line 2 say it. */
export const WAITING_ON_TEXT: Readonly<Record<Exclude<RecapWaitingOn, 'nothing'>, string>> = {
  you: 'Waiting on you',
  CI: 'Waiting on CI',
  'another session': 'Waiting on another session',
  'someone else': 'Waiting on someone else',
};

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

/**
 * A recap from recapPath()'s body, read defensively: every field of SessionRecap with its type, a
 * known `waitingOn` and `source`, and times that are times; anything else is no recap. Each text is
 * cut to RECAP_FIELD_MAX, and the title to the same, as the server should already have them.
 */
export function parseRecap(body: unknown): SessionRecap | undefined {
  if (!isRecord(body)) return undefined;
  const { why, now, next, waitingOn, title, at, throughAt, source, stale } = body;
  if (typeof why !== 'string' || typeof now !== 'string' || typeof next !== 'string' || typeof title !== 'string') return undefined;
  if (typeof waitingOn !== 'string' || !(RECAP_WAITING_ON as readonly string[]).includes(waitingOn)) return undefined;
  if (source !== 'pitwall' && source !== 'claude-code') return undefined;
  if (!isTime(at) || !isTime(throughAt)) return undefined;
  if (stale !== undefined && stale !== true) return undefined;
  const recap: SessionRecap = {
    why: cutText(why, RECAP_FIELD_MAX),
    now: cutText(now, RECAP_FIELD_MAX),
    next: cutText(next, RECAP_FIELD_MAX),
    waitingOn: waitingOn as RecapWaitingOn,
    title: cutText(title, RECAP_FIELD_MAX),
    at,
    throughAt,
    source,
  };
  if (stale === true) recap.stale = true;
  return recap;
}

/**
 * The strip's first line, chosen by what it waits on (Phil, 2026-10-29: "Sometimes it's like, 'Here's
 * what needs to be done.' Otherwise, it's just, 'Here's what was done,' or 'Here's what we're waiting
 * on.'"), with the field it shows, so the line below it shows the other:
 * - 'you': "You need to", and `next`, in the Needs you tone, subtle warning, as Asked you;
 * - 'CI', 'another session', 'someone else': "Waiting on CI" and the like, and `next`, quiet;
 * - 'nothing': "Done", and `now`, quiet success;
 * - Claude Code's own recap, which says only where it is: "Now", and `now`, quiet.
 * A field that's empty gives way to the other, so the line always says something.
 */
export interface RecapHeadline {
  label: string;
  look: BadgeLook;
  field: 'now' | 'next';
  text: string;
}

export function recapHeadline(recap: Pick<SessionRecap, 'waitingOn' | 'now' | 'next' | 'source'>): RecapHeadline {
  const pick = (field: 'now' | 'next'): Pick<RecapHeadline, 'field' | 'text'> => {
    const other = field === 'now' ? 'next' : 'now';
    return recap[field].trim() !== '' || recap[other].trim() === '' ? { field, text: recap[field] } : { field: other, text: recap[other] };
  };
  if (recap.source === 'claude-code') return { label: 'Now', look: 'subtle-neutral', ...pick('now') };
  if (recap.waitingOn === 'nothing') return { label: 'Done', look: 'subtle-success', ...pick('now') };
  if (recap.waitingOn === 'you') return { label: 'You need to', look: 'subtle-warning', ...pick('next') };
  return { label: WAITING_ON_TEXT[recap.waitingOn], look: 'subtle-neutral', ...pick('next') };
}

/** The strip's lines under its headline: Why, then whichever of Now and Next it didn't show, each left out when empty. */
export function recapLines(recap: Pick<SessionRecap, 'why' | 'now' | 'next'>, headline: Pick<RecapHeadline, 'field'>): { label: 'Why' | 'Now' | 'Next'; text: string }[] {
  const rest = headline.field === 'next' ? ({ label: 'Now', text: recap.now } as const) : ({ label: 'Next', text: recap.next } as const);
  return [{ label: 'Why' as const, text: recap.why }, rest].filter((line) => line.text.trim() !== '');
}

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
export const NOT_RECAPPED_TEXT = "pitwall doesn't recap this session.";

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
  const recap = session.recap;
  if (!recap || recap.stale || recap.source !== 'pitwall' || needsYou || session.ended) return undefined;
  if (recap.waitingOn === 'you' || recap.waitingOn === 'nothing') return undefined;
  if (session.status === 'busy' || (session.alive && session.state === 'working')) return undefined;
  return WAITING_ON_TEXT[recap.waitingOn];
}

/** How long Refresh stays busy waiting for the new recap: spike 010's calls took 3 to 7 s, plus the poll's 5. */
export const RECAP_WAIT_MS = 60_000;

/** What the strip shows. */
export type RecapStripState =
  /** No strip: recaps are off, the session has ended, or pitwall doesn't recap it. */
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
}

type Phase = 'idle' | 'queued' | 'asking' | 'awaiting';

/** The toast key Refresh's results share, so a second replaces the first. */
const TOAST_KEY = 'recap-refresh';

/** The recap behind one session's strip: what to show, and Refresh. See the top of this file for when it fetches and asks. */
export function useRecap({ api, session, health, listed, hidden, toast, delayFrom }: UseRecapOptions): RecapController {
  const { sessionId } = session;
  const summary = session.recap;
  const summaryAt = summary?.at;
  const enabled = api !== undefined && health !== undefined && session.ended !== true;

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
  // What a refresh waits for: a summary other than this one, or a failed call after these many.
  const awaited = useRef<{ fromAt: string | undefined; calls: number | undefined }>({ fromAt: undefined, calls: undefined });

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
      awaited.current = { fromAt: summaryRef.current?.at, calls: healthRef.current?.calls };
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
          const current = healthRef.current;
          if (budgetSpent(current)) return say('info', budgetText(current?.budget ?? 0));
          // Not the budget: a call for it is already running, so its recap is on its way.
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

  // Once, as the view is first shown: a stale recap, or none, asks for one, after --pw-delay-attach.
  // Hidden before then, as by a root tab's switch, it decides again when it's shown.
  const stale = summary !== undefined ? summary.stale === true : fetched?.stale === true;
  const wanted = summary === undefined || summary.stale === true;
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
        post(true);
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
  // has been fetched, or fetching it has failed, so Refresh isn't idle beside the old one; until a call
  // fails; or for RECAP_WAIT_MS.
  const calls = health?.calls;
  const failedSince = health?.error !== undefined && calls !== undefined && awaited.current.calls !== undefined && calls > awaited.current.calls;
  const arrived = summaryAt !== awaited.current.fromAt && (fetchedAt === summaryAt || (got !== undefined && got.for === summaryAt && got.status !== 'loading'));
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
