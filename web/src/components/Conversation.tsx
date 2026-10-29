// The session view's conversation (docs/design-system.md, 4: Conversation): the Conversation tab's
// panel, which is the view's scrolling body. An <ol> of entries, oldest first, opening scrolled to the
// newest: your messages, Claude's, its messages to pitwall's relay, messages from other sessions and
// notices, each text entry with its speaker line and time, and tool calls, two or more in a row folded
// into one toggle. A message to pitwall's relay is the session's SendMessage call to it, shown in full
// in the call's place (W46), "To pitwall-relay": it's never folded with the calls around it. Nor is a
// question Claude Code asked in its dialog (W49), "Claude asked": each question with its options, the
// answer marked, as text.
//
// - The newest page is fetched when the view opens, and again whenever the session's activity time
//   moves; it's merged onto the end without duplicating an entry (conversation.ts). Older pages come
//   from "Load earlier", and the reader's place holds as they arrive above it.
// - While the session works and its Conversation tab is shown, the newest page is fetched every 2 s
//   too (WORKING_POLL_MS, W102), one request at a time, and not while the browser tab is hidden. At
//   the end, after the newest entry, the working line says what it's doing, or that it waits on you
//   (WorkingLine.tsx).
// - At the bottom, new entries keep it there. Scrolled up, the place is kept, and "n new · Jump to
//   latest" sticks to the bottom of the body until the reader gets there by any means. Each batch
//   that adds to the count is announced once, as "n new", never the entries' text.
// - Behind the Terminal tab, the panel is hidden (display: none), which leaves it no size and lets the
//   browser drop its scroll position. Nothing counts as the reader's place while it's hidden, and
//   shown again it goes back to the place they left, or to the bottom if they were there (W29).
// - A fold stays open or closed across refreshes and "Load earlier" while it has a call it had.
// - Claude's messages, its messages to pitwall and other sessions' are markdown, shown as pitwall's own
//   elements (Markdown.tsx); your prompts, notices and tool calls are plain text. Nothing is ever HTML
//   (6.1, rule 16).
//
// Its states (4: Empty states and Skeletons and spinners, and 5: Errors):
// - Waiting for the first page: "Loading the conversation…" after --pw-delay-spinner, and what's
//   slow after --pw-delay-long. Nothing yet, no transcript, and no API client are status lines too.
// - A failure is an inline alert with Try again (outline sm, `retry`, busy while it's out): danger
//   when nothing is shown ("Couldn't load the conversation."), warning when what's shown is kept.
//   A refresh that fails keeps the entries and says they may be out of date; so does "Couldn't load
//   earlier messages.", in Load earlier's place. The HTTP status and the server's reason, as text,
//   follow pitwall's sentence.
// - A transcript that changed under Load earlier starts again from its newest page, at the top,
//   under a neutral notice; one that's gone keeps what was shown, with a neutral notice at the end.
//
// A sub-agent's transcript (W77) is the same panel, read-only, in the Sub-agents tab (Subagents.tsx).
// An entry about one of the session's sub-agents (`subagent`, W76) names it by its description: a
// report reads "From sub-agent: *description*", and an Agent or SendMessage call names it on its line,
// each with a link that opens its transcript in the Sub-agents tab (SubagentLinkContext).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import type { AskedQuestion, ConversationEntry, ConversationPage } from '../../../src/shared/protocol.js';
import {
  chosenAnswer,
  conversationRows,
  countAdded,
  foldOpen,
  mergeNewest,
  prependOlder,
  toggleFold,
  type ConversationResult,
  type KeyedEntry,
} from '../conversation.js';
import { clockTime, couldNot, plainText } from '../format.js';
import { Alert, Detail } from './Alert.js';
import { Badge } from './Badge.js';
import { Button } from './Button.js';
import { Icon } from './Icon.js';
import { RELAY_SESSION_NAME } from '../relayName.js';
import { Markdown } from './Markdown.js';
import { Timestamp } from './Timestamp.js';
import { Tooltip } from './Tooltip.js';
import { useWaiting } from './Waiting.js';
import { WorkingAnnouncer, WorkingLine } from './WorkingLine.js';
import { subagentName } from '../subagents.js';
import type { WorkingLineState } from '../working.js';

/**
 * - `loading`: the first page hasn't arrived.
 * - `ready`: a page has arrived.
 * - `missing`: the server has no transcript for the session, or no longer lists it.
 * - `failed`: the first page couldn't be loaded.
 * - `unavailable`: there's no API client, as in tests that render the dashboard alone.
 */
type Status = 'loading' | 'ready' | 'missing' | 'failed' | 'unavailable';

/** Why a page didn't load: the HTTP status, when the server answered, and the reason it gave, when it gave one. */
export interface LoadFailure {
  status?: number;
  error?: string;
}

interface ConversationState {
  status: Status;
  /** Oldest first. */
  entries: ConversationEntry[];
  /** The cursor for the page before the oldest entry shown. */
  before?: string;
  earlier: 'idle' | 'loading' | 'failed';
  /** Why "Load earlier" last failed, until it works: its alert stays, with Try again busy, while it tries again. */
  earlierFailure?: LoadFailure;
  /** The transcript changed under "Load earlier", so the view started again from the newest page. */
  reloaded: boolean;
  /** How many entries arrived while the reader was scrolled up: the count on "Jump to latest". */
  unseen: number;
  /**
   * A newer page arrived that doesn't meet what's shown (more arrived than a page holds) while the
   * reader was scrolled up. What's shown stays, and the newest waits behind "Jump to latest", whose
   * count is then at least `unseen`: "50+ new".
   */
  gap: boolean;
  /**
   * Why the newest page last failed, until one arrives: the first page (status 'failed', nothing
   * shown), or a refresh, which keeps what's shown, which may now be out of date.
   */
  failure?: LoadFailure;
  /** Try again on the newest page is out: its button is busy. */
  retrying: boolean;
  /**
   * How many times Try again has failed, for the newest page and for Load earlier: each alert is keyed
   * by its count, so a failure that says the same as the last one is a new alert, and announced again.
   */
  attempts: { newest: number; earlier: number };
  /** Whether the newest page last fetched said its newest turn has ended (ConversationPage.turnEnded, W102). */
  turnEnded?: boolean;
}

/** Fetches one page of the session's conversation: the newest, or the one before `before`. Never rejects. */
export type PageLoader = (before?: string) => Promise<ConversationResult>;

type ScrollIntent = { kind: 'bottom' } | { kind: 'top' } | { kind: 'keep'; height: number; top: number };

/** How close to the bottom counts as at the bottom, for following new entries. */
export const AT_BOTTOM_PX = 24;

/** How long a smooth jump to the latest entry may take before the reader's scrolling counts again. */
const JUMP_MS = 1_500;

function isAtBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= AT_BOTTOM_PX;
}

/**
 * Hidden, as the panel is behind the Terminal tab: it has no size, so it would read as at the bottom,
 * and its scrollTop as 0.
 */
function isHidden(element: HTMLElement): boolean {
  return element.closest('[hidden]') !== null;
}

/** Whether the reader asked for less motion (2.13): the jump to the latest entry then doesn't animate. */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function withBefore(state: ConversationState, before: string | undefined): ConversationState {
  const { before: _old, ...rest } = state;
  return before === undefined ? rest : { ...rest, before };
}

/** `state` with what the newest page said of its turn's end, or without it when it said nothing. */
function withTurnEnded(state: ConversationState, turnEnded: boolean | undefined): ConversationState {
  const { turnEnded: _old, ...rest } = state;
  return turnEnded === undefined ? rest : { ...rest, turnEnded };
}

/** `state` with `failure` set to `failure`, or without one. */
function withFailure(state: ConversationState, key: 'failure' | 'earlierFailure', failure: LoadFailure | undefined): ConversationState {
  const { [key]: _old, ...rest } = state;
  return failure === undefined ? rest : { ...rest, [key]: failure };
}

/** The failure in a result that isn't a page. */
function failureOf(result: { status?: number; error?: string }): LoadFailure {
  const failure: LoadFailure = {};
  if (result.status !== undefined) failure.status = result.status;
  if (result.error !== undefined) failure.error = result.error;
  return failure;
}

/** What `useConversation` gives the view and its panel. */
export interface ConversationController {
  state: ConversationState;
  loadEarlier: () => Promise<void>;
  retry: () => void;
  /** The panel, which is what scrolls. */
  scroller: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  /** The reader scrolling, pressing or touching: a smooth jump in progress stops counting as theirs. */
  onInput: () => void;
  /** Where the reader is, again, after something moved the content without scrolling, such as a fold. */
  sync: () => void;
  /** "Jump to latest": to the bottom, smoothly unless the reader asked for less motion. */
  jumpToLatest: () => void;
  /** Shown again after being hidden: back to the bottom if the reader was there, or else to the place they left. */
  restorePlace: () => void;
  /** What's at the end grew or shrank without new entries, as the working line does: stay at the bottom if there. */
  follow: () => void;
}

export interface ConversationOptions {
  /**
   * Fetches the newest page this often, in ms, as well as when the activity time moves, while it's
   * set and the browser tab isn't hidden, until a newest page says its turn has ended
   * (ConversationPage.turnEnded): the session view sets it while Claude Code says the session works
   * and its Conversation tab is shown (WORKING_POLL_MS, W102), which a plugin's monitor can say of an
   * idle session (spike 007, finding 6). The next fetch waits for the last one's answer.
   */
  pollMs?: number | undefined;
}

/**
 * A session's conversation: the newest page when the view opens, merged again whenever the session's
 * activity time moves, and older pages on request. It follows new entries only while the reader is at
 * the bottom, and counts those that arrive while they aren't.
 */
export function useConversation(lastActivityAt: string | undefined, loader: PageLoader | undefined, options: ConversationOptions = {}): ConversationController {
  const { pollMs } = options;
  const [state, setState] = useState<ConversationState>(() => ({
    status: loader ? 'loading' : 'unavailable',
    entries: [],
    earlier: 'idle',
    reloaded: false,
    unseen: 0,
    gap: false,
    retrying: false,
    attempts: { newest: 0, earlier: 0 },
  }));
  // Which alert's Try again had focus when its attempt failed again: the new alert's button takes it.
  const refocus = useRef<'newest' | 'earlier' | undefined>(undefined);
  // The newest page, while it waits behind "Jump to latest" because it doesn't meet what's shown (`gap`).
  const waitingPage = useRef<ConversationPage | undefined>(undefined);
  // The state as last committed, for the async loads to build on.
  const stateRef = useRef(state);
  // Bumped whenever the entries are replaced, so an older page asked for before then is dropped.
  const epoch = useRef(0);
  // Only the latest request for the newest page counts.
  const newestRequest = useRef(0);
  // How many requests for the newest page are out, so a poll never adds one while another is (W102).
  const newestOut = useRef(0);
  const alive = useRef(true);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  // The reader's place, as last seen while the panel was shown, for when it's shown again.
  const place = useRef(0);
  const scrollIntent = useRef<ScrollIntent | undefined>(undefined);
  // While a smooth jump to the latest entry runs, the positions it passes through aren't the reader's.
  const jumping = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const commit = useCallback((next: ConversationState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const endJump = useCallback(() => {
    clearTimeout(jumping.current);
    jumping.current = undefined;
  }, []);

  /** Focus on the "Jump to latest" bar, which is going, moves to the panel first, so the keyboard carries on from there. */
  const leaveBar = useCallback(() => {
    const element = scroller.current;
    if (element && document.activeElement instanceof Element && document.activeElement.closest('.jump-latest') && element.contains(document.activeElement)) {
      element.focus({ preventScroll: true });
    }
  }, []);

  /**
   * The newest page that was waiting behind the bar takes the place of what's shown, at the bottom, as
   * a page that doesn't overlap does when the reader is already there. Older pages asked for before
   * then are dropped, and Load earlier goes on from the newest page's cursor.
   */
  const showWaitingPage = useCallback((): boolean => {
    const waiting = waitingPage.current;
    if (!waiting) return false;
    waitingPage.current = undefined;
    leaveBar();
    epoch.current += 1;
    scrollIntent.current = { kind: 'bottom' };
    const { attempts, turnEnded } = stateRef.current;
    commit(withTurnEnded(withBefore({ status: 'ready', entries: waiting.entries, earlier: 'idle', reloaded: false, unseen: 0, gap: false, retrying: false, attempts }, waiting.before), turnEnded));
    return true;
  }, [commit, leaveBar]);

  /** At the bottom: nothing is unseen any more, and the bar goes. Focus on it moves to the panel first. */
  const reachedBottom = useCallback(() => {
    const current = stateRef.current;
    // At the end of what's shown, with a newer page waiting beyond a gap: that's where they go on reading.
    if (showWaitingPage()) return;
    if (current.unseen === 0) return;
    leaveBar();
    commit({ ...current, unseen: 0 });
  }, [commit, leaveBar, showWaitingPage]);

  /**
   * Before an alert goes, as one does once its Try again works: focus on its button moves to the
   * panel, so the keyboard carries on from there rather than from the page.
   */
  const keepFocus = useCallback(() => {
    const element = scroller.current;
    const active = document.activeElement;
    if (element && active instanceof Element && active.closest('.conversation-alert') && element.contains(active)) element.focus({ preventScroll: true });
  }, []);

  /** Whether focus is inside the alert for the newest page's failure, or Load earlier's. */
  const focusIn = (which: 'newest' | 'earlier') => {
    const active = document.activeElement;
    return active instanceof Element && scroller.current?.contains(active) === true && active.closest(`.conversation-alert.${which}`) !== null;
  };

  const sync = useCallback(() => {
    const element = scroller.current;
    if (!element || isHidden(element)) return;
    place.current = element.scrollTop;
    const bottom = isAtBottom(element);
    if (jumping.current !== undefined) {
      if (!bottom) return;
      endJump();
    }
    atBottom.current = bottom;
    if (bottom) reachedBottom();
  }, [endJump, reachedBottom]);

  const loadNewest = useCallback(
    async (options: { replace: boolean; reloaded?: boolean }) => {
      if (!loader) return;
      const request = ++newestRequest.current;
      newestOut.current += 1;
      let result: ConversationResult;
      try {
        result = await loader();
      } finally {
        newestOut.current -= 1;
      }
      if (!alive.current || request !== newestRequest.current) return;
      const current = stateRef.current;
      if (result.kind === 'ok') {
        if (current.failure !== undefined) keepFocus();
        const { turnEnded } = result.page;
        const settled = withTurnEnded(withFailure({ ...current, retrying: false }, 'failure', undefined), turnEnded);
        const fresh = options.replace || current.status !== 'ready';
        if (fresh) waitingPage.current = undefined;
        const waiting = waitingPage.current;
        if (waiting) {
          // A page is already waiting beyond a gap: the newer one joins it, and what's shown stays.
          const joined = mergeNewest(waiting.entries, result.page.entries);
          const next: ConversationPage = joined === undefined ? result.page : { ...waiting, entries: joined };
          waitingPage.current = next;
          commit({ ...settled, unseen: current.unseen + countAdded(waiting.entries, next.entries), gap: true });
          return;
        }
        const merged = fresh ? undefined : mergeNewest(current.entries, result.page.entries);
        if (merged === undefined && !fresh && !atBottom.current) {
          // More arrived than a page holds while the reader was scrolled up: their place and what's shown
          // stay, and the newest page waits behind "Jump to latest", counted as at least what it holds.
          waitingPage.current = result.page;
          commit({ ...settled, unseen: current.unseen + countAdded(current.entries, result.page.entries), gap: true });
          return;
        }
        if (merged === undefined) {
          epoch.current += 1;
          // After a stale cursor, the reader was at the top, pressing Load earlier: they stay there, under the notice.
          scrollIntent.current = { kind: options.reloaded === true ? 'top' : 'bottom' };
          commit(
            withTurnEnded(
              withBefore(
                {
                  status: 'ready',
                  entries: result.page.entries,
                  earlier: 'idle',
                  reloaded: options.reloaded === true,
                  unseen: 0,
                  gap: false,
                  retrying: false,
                  attempts: current.attempts,
                },
                result.page.before,
              ),
              turnEnded,
            ),
          );
        } else if (atBottom.current) {
          scrollIntent.current = { kind: 'bottom' };
          commit({ ...settled, entries: merged });
        } else {
          // Scrolled up: the place is kept, and what arrived is counted.
          commit({ ...settled, entries: merged, unseen: current.unseen + countAdded(current.entries, merged) });
        }
      } else if (result.kind === 'not-found') {
        // What's shown is kept, with a notice at the end that the transcript has gone.
        if (atBottom.current && current.entries.length > 0) scrollIntent.current = { kind: 'bottom' };
        commit(withFailure({ ...current, status: 'missing', retrying: false }, 'failure', undefined));
      } else if (result.kind === 'failed') {
        // A Try again that failed: its alert is a new one, announced again even when it says the same.
        const again = current.retrying;
        if (again && focusIn('newest')) refocus.current = 'newest';
        const attempts = again ? { ...current.attempts, newest: current.attempts.newest + 1 } : current.attempts;
        if (current.entries.length > 0) {
          // A refresh that fails keeps what's on screen, and says it may be out of date, at the end,
          // where the reader at the bottom sees it. The next change of activity, or Try again, tries again.
          if (atBottom.current) scrollIntent.current = { kind: 'bottom' };
          commit(withFailure({ ...current, retrying: false, attempts }, 'failure', failureOf(result)));
        } else {
          commit(withFailure({ ...current, status: 'failed', retrying: false, attempts }, 'failure', failureOf(result)));
        }
      } else {
        // On 'unauthorized' the app has already replaced the dashboard with the token notice.
        commit({ ...current, retrying: false });
      }
    },
    [loader, commit, keepFocus],
  );

  const loadEarlier = useCallback(async () => {
    const current = stateRef.current;
    if (!loader || current.before === undefined || current.earlier === 'loading') return;
    const started = epoch.current;
    commit({ ...current, earlier: 'loading' });
    const result = await loader(current.before);
    if (!alive.current || started !== epoch.current) return;
    const latest = stateRef.current;
    if (result.kind === 'ok') {
      if (latest.earlierFailure !== undefined) keepFocus();
      const element = scroller.current;
      if (element) scrollIntent.current = { kind: 'keep', height: element.scrollHeight, top: element.scrollTop };
      const loaded = { ...latest, entries: prependOlder(result.page.entries, latest.entries), earlier: 'idle' as const };
      commit(withBefore(withFailure(loaded, 'earlierFailure', undefined), result.page.before));
    } else if (result.kind === 'stale') {
      if (latest.earlierFailure !== undefined) keepFocus();
      commit(withFailure({ ...latest, earlier: 'idle' }, 'earlierFailure', undefined));
      await loadNewest({ replace: true, reloaded: true });
    } else if (result.kind === 'unauthorized') {
      commit({ ...latest, earlier: 'idle' });
    } else {
      // A 404 here means the transcript has gone: it's still a failed read, never "nothing earlier".
      const failure = result.kind === 'failed' ? failureOf(result) : { status: 404 };
      // From the alert's Try again: a new alert, announced again even when it says the same.
      const again = latest.earlierFailure !== undefined;
      if (again && focusIn('earlier')) refocus.current = 'earlier';
      const attempts = again ? { ...latest.attempts, earlier: latest.attempts.earlier + 1 } : latest.attempts;
      commit(withFailure({ ...latest, earlier: 'failed', attempts }, 'earlierFailure', failure));
    }
  }, [loader, commit, loadNewest, keepFocus]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimeout(jumping.current);
    };
  }, []);

  // The newest page when the view opens, and again whenever the session's activity time moves.
  useEffect(() => {
    void loadNewest({ replace: false });
  }, [loadNewest, lastActivityAt]);

  // While it's asked for (pollMs, W102): the newest page again every pollMs, counted from the last
  // answer, and only once one has come in. Never a second request while one is out, and none while the
  // browser tab is hidden: it goes again as soon as the tab is shown. Not once the newest page says the
  // turn has ended: the next move of the activity time fetches it again, and says if another began.
  const polling = pollMs !== undefined && state.turnEnded !== true ? pollMs : undefined;
  useEffect(() => {
    if (polling === undefined || !loader || typeof document === 'undefined') return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hidden = () => document.visibilityState === 'hidden';
    const schedule = () => {
      clearTimeout(timer);
      timer = hidden() ? undefined : setTimeout(() => void tick(), polling);
    };
    const tick = async () => {
      timer = undefined;
      if (stopped || hidden()) return;
      if (newestOut.current === 0 && stateRef.current.status === 'ready') await loadNewest({ replace: false });
      if (!stopped) schedule();
    };
    const onVisibility = () => {
      if (stopped) return;
      if (hidden()) {
        clearTimeout(timer);
        timer = undefined;
      } else if (timer === undefined) {
        void tick();
      }
    };
    schedule();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [polling, loader, loadNewest]);

  // Follow new entries only when already at the bottom; keep the place when older ones arrive above.
  // A notice or an alert at the end, at the bottom, is followed the same way.
  useLayoutEffect(() => {
    // A Try again that failed again: its alert was replaced, so its button's focus goes to the new one's.
    const again = refocus.current;
    refocus.current = undefined;
    if (again) scroller.current?.querySelector<HTMLElement>(`.conversation-alert.${again} button`)?.focus();
    const intent = scrollIntent.current;
    const element = scroller.current;
    scrollIntent.current = undefined;
    if (!intent || !element) return;
    if (isHidden(element)) {
      // Entries that arrive behind the Terminal tab: following them waits until it's shown again.
      if (intent.kind === 'bottom') atBottom.current = true;
      return;
    }
    element.scrollTop =
      intent.kind === 'bottom' ? element.scrollHeight : intent.kind === 'top' ? 0 : intent.top + (element.scrollHeight - intent.height);
    place.current = element.scrollTop;
    atBottom.current = isAtBottom(element);
  }, [state]);

  // The scroller changes size without scrolling when the header or the message box below it grows or
  // shrinks (a send's result, a reply arriving, the box resized) and when the window does. Stay at the
  // bottom if already there; otherwise the place is kept, as the browser leaves scrollTop alone, and
  // the reader may have come to the bottom without scrolling.
  useEffect(() => {
    const element = scroller.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      // Hidden, its size is none: that's not the reader moving, and not the bottom.
      if (isHidden(element)) return;
      if (atBottom.current) element.scrollTop = element.scrollHeight;
      else sync();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [sync]);

  /** Try again, on the newest page: its alert stays, with the button busy, until the page arrives or fails again. */
  const retry = useCallback(() => {
    const current = stateRef.current;
    if (current.retrying) return;
    commit({ ...current, retrying: true });
    void loadNewest({ replace: current.entries.length === 0 });
  }, [commit, loadNewest]);

  const jumpToLatest = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    endJump();
    // Beyond a gap, the newest page replaces what's shown, at its bottom: there's nothing to scroll through.
    if (showWaitingPage()) {
      atBottom.current = true;
      return;
    }
    atBottom.current = true;
    reachedBottom();
    const smooth = !prefersReducedMotion();
    if (smooth) jumping.current = setTimeout(endJump, JUMP_MS);
    if (typeof element.scrollTo === 'function') element.scrollTo({ top: element.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    else element.scrollTop = element.scrollHeight;
  }, [endJump, reachedBottom, showWaitingPage]);

  const restorePlace = useCallback(() => {
    const element = scroller.current;
    if (!element || isHidden(element)) return;
    element.scrollTop = atBottom.current ? element.scrollHeight : place.current;
    sync();
  }, [sync]);

  const follow = useCallback(() => {
    const element = scroller.current;
    if (!element || isHidden(element) || !atBottom.current) return;
    element.scrollTop = element.scrollHeight;
    place.current = element.scrollTop;
  }, []);

  return { state, loadEarlier, retry, scroller, onScroll: sync, onInput: endJump, sync, jumpToLatest, restorePlace, follow };
}

/** "n tool calls", "1 error", "n errors". */
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The sub-agent an entry is about (ConversationEntry.subagent). */
export type SubagentRef = NonNullable<ConversationEntry['subagent']>;

/**
 * Opens a sub-agent's transcript in the session view's Sub-agents tab (W77), for the links on the
 * entries about one. Without it, as in the gallery's conversations and the tests of a panel alone,
 * the entries name the sub-agent as text.
 */
export const SubagentLinkContext = createContext<((subagent: SubagentRef) => void) | undefined>(undefined);

/** What a link to a sub-agent's transcript says it does: in its tooltip, which describes it. */
export const SUBAGENT_LINK_HINT = 'Open its transcript in the Sub-agents tab';

/**
 * A sub-agent named by its description: a link-styled button that opens its transcript in the
 * Sub-agents tab, named by the description it shows, or the description as text where there's no
 * tab to open (W77).
 */
export function SubagentName({ subagent }: { subagent: SubagentRef }) {
  const open = useContext(SubagentLinkContext);
  const name = subagentName(subagent.description);
  if (!open) return <span className="subagent-name">{name}</span>;
  return (
    <Tooltip content={SUBAGENT_LINK_HINT}>
      <button type="button" className="link-button subagent-link" data-agent-link={subagent.agentId} onClick={() => open(subagent)}>
        {name}
      </button>
    </Tooltip>
  );
}

/**
 * What an Agent or SendMessage call about a sub-agent says before its name: "Agent: " for the call that
 * started it, "SendMessage to " for one sent to it, and the tool's name otherwise.
 */
function subagentCallLead(entry: ConversationEntry): string {
  const tool = plainText(entry.toolName ?? 'Agent');
  return tool === 'SendMessage' ? 'SendMessage to ' : `${tool}: `;
}

/** A tool call's one line, cut with an ellipsis, the whole of it in a tooltip when it's cut, and its error badge. */
function ToolCall({ entry }: { entry: ConversationEntry }) {
  const { subagent } = entry;
  const error = entry.toolError && (
    <Badge look="subtle-danger" className="tool-call-error">
      error
    </Badge>
  );
  if (subagent) {
    // A call about one of the session's sub-agents names it by its description, with its link (W77).
    // No tooltip of the line's own, cut or not: the link has one, and two would open at once.
    return (
      <>
        <span className="tool-call-text">
          {subagentCallLead(entry)}
          <SubagentName subagent={subagent} />
        </span>
        {error}
      </>
    );
  }
  const text = plainText(entry.text);
  return (
    <>
      {/* Never focusable, so it opens on hover; the whole line is in the DOM for screen readers and find. */}
      <Tooltip content={text} relation="none" onlyIfCut>
        <span className="tool-call-text">{text}</span>
      </Tooltip>
      {error}
    </>
  );
}

interface FoldProps {
  calls: KeyedEntry[];
  open: boolean;
  onToggle: (calls: KeyedEntry[]) => void;
}

/** Two or more tool calls in a row: a toggle, "n tool calls", with an error count, over their lines. */
function Fold({ calls, open, onToggle }: FoldProps) {
  const listId = useId();
  const errors = calls.filter(({ entry }) => entry.toolError).length;
  const label = plural(calls.length, 'tool call', 'tool calls');
  const errorCount = errors > 0 ? plural(errors, 'error', 'errors') : undefined;
  return (
    <li className="entry entry-fold">
      <button
        type="button"
        className="fold-toggle"
        // "3 tool calls, 1 error": the label and the badge, with the pause between them that the screen doesn't show.
        aria-label={errorCount === undefined ? undefined : `${label}, ${errorCount}`}
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => onToggle(calls)}
      >
        <Icon name="expand" className="chevron" />
        <span className="fold-label">{label}</span>
        {errorCount !== undefined && <Badge look="subtle-danger">{errorCount}</Badge>}
      </button>
      <ol className="tool-calls" id={listId} hidden={!open}>
        {calls.map(({ key, entry }) => (
          <li key={key} className={entry.toolError ? 'tool-call has-error' : 'tool-call'}>
            <ToolCall entry={entry} />
          </li>
        ))}
      </ol>
    </li>
  );
}

/**
 * The speaker line of a message the session sent pitwall's relay (W46): the name the call addressed,
 * as a message from another session names its sender ("From name"). Any local session can take the
 * relay's name, so the line says only what the transcript shows, never that pitwall received it (W48).
 */
export const TO_PITWALL_SPEAKER = `To ${RELAY_SESSION_NAME}`;

/** The speaker lines that are fixed words. Another session's message names its sender. */
const SPEAKERS: Partial<Record<ConversationEntry['kind'], string>> = { user: 'You', assistant: 'Claude', 'to-pitwall': TO_PITWALL_SPEAKER };

/** Claude's messages, its messages to pitwall and other sessions' carry markdown; nothing else is ever rendered as markdown. */
function isMarkdown(entry: ConversationEntry): boolean {
  return entry.markdown === true && (entry.kind === 'assistant' || entry.kind === 'cross-session' || entry.kind === 'to-pitwall');
}

/** What a report from one of the session's sub-agents says before its name (W77). */
export const SUBAGENT_SPEAKER = 'From sub-agent: ';

/** The speaker line of a question Claude Code asked in its dialog (W49). */
export const QUESTION_SPEAKER = 'Claude asked';

/** The speaker line: who, then " · 11:06" when the entry has a time. */
function Speaker({ entry, children }: { entry: ConversationEntry; children: ReactNode }) {
  const time = entry.at !== undefined && clockTime(entry.at) !== undefined ? entry.at : undefined;
  return (
    <p className="entry-speaker">
      {children}
      {time !== undefined && (
        <span className="entry-time">
          {' · '}
          <Timestamp at={time} format="time" />
        </span>
      )}
    </p>
  );
}

/**
 * One question of a dialog (W49): its header, the question, a note when more than one option could
 * be chosen, and its options as a list named by the question, each chosen one marked "Your answer",
 * visibly and to a screen reader. An answer that names no option is shown as typed, and notes follow.
 * In a dialog that wasn't answered (`dismissed`), nothing is marked. With `sayMissing`, a question
 * with no answer says so. Every string is plain text.
 */
function Question({ question, dismissed, sayMissing, alone }: { question: AskedQuestion; dismissed: boolean; sayMissing: boolean; alone: boolean }) {
  const id = useId();
  const answer = dismissed ? undefined : chosenAnswer(question);
  const Tag = alone ? 'div' : 'li';
  return (
    <Tag className="question">
      {question.header !== undefined && <p className="question-header">{plainText(question.header)}</p>}
      <p className="question-text" id={id}>
        {plainText(question.question)}
      </p>
      {question.multiSelect === true && <p className="question-note">You could choose more than one.</p>}
      {question.options.length > 0 && (
        <ul className="question-options" aria-labelledby={id}>
          {question.options.map((option, index) => {
            const chosen = answer?.chosen.has(index) === true;
            return (
              <li key={index} className={chosen ? 'question-option chosen' : 'question-option'}>
                {chosen ? <Icon name="checked" className="question-option-icon" /> : <span className="question-option-icon" aria-hidden="true" />}
                <div className="question-option-body">
                  <p className="question-option-label">
                    {plainText(option.label)}
                    {chosen && (
                      <span className="question-option-chosen">
                        {/* The pause a screen reader needs between the label and what it is; the screen shows the gap. */}
                        <span className="visually-hidden">, </span>
                        Your answer
                      </span>
                    )}
                  </p>
                  {option.description !== undefined && <p className="question-option-description">{plainText(option.description)}</p>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {answer?.typed !== undefined && (
        <div className="question-typed">
          <p className="question-typed-label">Your answer</p>
          <p className="question-typed-text">{plainText(answer.typed)}</p>
        </div>
      )}
      {question.notes !== undefined && (
        <div className="question-typed question-notes">
          <p className="question-typed-label">Your notes</p>
          <p className="question-typed-text">{plainText(question.notes)}</p>
        </div>
      )}
      {sayMissing && answer === undefined && <p className="question-note">No answer in the transcript.</p>}
    </Tag>
  );
}

/**
 * A question Claude Code asked in its dialog (W49): "Claude asked", its time, then each question.
 * A dialog that wasn't answered, whose result was an error, says so once, after its questions; so
 * does one whose answers aren't in the transcript at all. With several questions, they're a list.
 */
function QuestionEntry({ entry }: { entry: ConversationEntry }) {
  // A question entry always has its questions; one that came without says its one-line text.
  const questions = entry.questions !== undefined && entry.questions.length > 0 ? entry.questions : [{ question: entry.text, options: [] }];
  const dismissed = entry.toolError === true;
  // None answered: said once, for the whole dialog, rather than under each question.
  const none = !dismissed && questions.every((question) => question.answer === undefined);
  const alone = questions.length === 1;
  const items = questions.map((question, index) => <Question key={index} question={question} dismissed={dismissed} sayMissing={!dismissed && !none} alone={alone} />);
  return (
    <li className="entry entry-question">
      <Speaker entry={entry}>{QUESTION_SPEAKER}</Speaker>
      {alone ? items : <ol className="questions">{items}</ol>}
      {dismissed && <p className="question-status">Not answered.</p>}
      {none && <p className="question-status">{alone ? 'No answer in the transcript.' : 'No answers in the transcript.'}</p>}
      {entry.truncated && <p className="entry-cut">Cut short.</p>}
    </li>
  );
}

/**
 * One entry that isn't folded. Markdown as pitwall's own elements, and anything else as text, its line
 * breaks and spaces kept by CSS. Never HTML.
 */
function Entry({ entry, userSpeaker }: { entry: ConversationEntry; userSpeaker: ReactNode | undefined }) {
  if (entry.kind === 'tool') {
    return (
      <li className={entry.toolError ? 'entry entry-tool has-error' : 'entry entry-tool'}>
        <ToolCall entry={entry} />
      </li>
    );
  }
  if (entry.kind === 'question') return <QuestionEntry entry={entry} />;
  const text = plainText(entry.text);
  const cut = entry.truncated && <p className="entry-cut">Cut short.</p>;
  if (entry.kind === 'notice') {
    return (
      <li className="entry entry-notice">
        <p className="entry-text">{text}</p>
        {cut}
      </li>
    );
  }
  // A report from one of the session's sub-agents names it by its description, with its link (W77).
  const speaker =
    entry.kind === 'cross-session' && entry.subagent ? (
      <>
        {SUBAGENT_SPEAKER}
        <SubagentName subagent={entry.subagent} />
      </>
    ) : entry.kind === 'cross-session' ? (
      `From ${plainText(entry.from ?? 'another session')}`
    ) : entry.kind === 'user' && userSpeaker !== undefined ? (
      // In a sub-agent's transcript, what started or messaged it: never the user's own prompt (W77).
      userSpeaker
    ) : (
      SPEAKERS[entry.kind]
    );
  const body = isMarkdown(entry) ? (
    <div className="entry-text entry-markdown">
      <Markdown text={text} />
    </div>
  ) : (
    <p className="entry-text">{text}</p>
  );
  return (
    <li className={`entry entry-${entry.kind}`}>
      <Speaker entry={entry}>{speaker}</Speaker>
      {body}
      {cut}
    </li>
  );
}

/**
 * pitwall's sentence for a failed load, then the server's reason as text when it gave one, or else
 * the HTTP status before the full stop, as the session actions do (5: Errors).
 */
export function failedText(what: string, failure: LoadFailure | undefined, after = ''): ReactNode {
  const sentence = couldNot(what, failure?.error === undefined ? failure?.status : undefined);
  return (
    <>
      {after === '' ? sentence : `${sentence.slice(0, -1)}${after}`}
      {failure?.error !== undefined && (
        <>
          {' '}
          <Detail>{plainText(failure.error)}</Detail>
        </>
      )}
    </>
  );
}

/** Try again, on an alert: outline sm with the `retry` icon, busy while it's out. */
export function TryAgain({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <Button size="sm" icon="retry" busy={busy} busyLabel="Trying again…" onClick={onClick}>
      Try again
    </Button>
  );
}

/** The conversation's status line, a role="status" that's always there: what's loading, or why there's nothing. */
function statusLine(state: ConversationState, shown: boolean, lines: { empty?: string | undefined; missing?: string | undefined }): string | undefined {
  const empty = state.entries.length === 0;
  switch (state.status) {
    case 'loading':
      return shown ? 'Loading the conversation…' : undefined;
    case 'missing':
      return empty ? (lines.missing ?? 'No transcript for this session.') : undefined;
    case 'unavailable':
      return "The conversation can't be loaded here.";
    case 'ready':
      return empty && state.before === undefined ? (lines.empty ?? 'Nothing to show yet.') : undefined;
    case 'failed':
      return undefined;
  }
}

export interface ConversationPanelProps {
  conversation: ConversationController;
  /** The tab panel's id, which the Conversation tab controls. */
  id: string;
  /** The Conversation tab's id, which names the panel; or, for a sub-agent's transcript, its heading's. */
  labelledBy: string;
  hidden: boolean;
  /**
   * 'tabpanel', the Conversation tab's panel, by default; 'region' for a sub-agent's transcript inside
   * the Sub-agents tab's panel (W77), named by its heading.
   */
  role?: 'tabpanel' | 'region';
  /** Nothing yet, in its status line: "Nothing to show yet." by default. */
  emptyLine?: string;
  /** No transcript, in its status line: "No transcript for this session." by default. */
  missingLine?: string;
  /**
   * Who a 'user' entry is from, in place of "You": in a sub-agent's transcript, what started or
   * messaged it, the session or the sub-agent that started it (W77).
   */
  userSpeaker?: ReactNode;
  /**
   * The working line at the end, after the newest entry, and its announcements (W102), for the
   * session's own conversation: while it's `idle` there's no line, but the status region is there, to
   * say "Finished". None for a sub-agent's transcript.
   */
  working?: WorkingLineState | undefined;
  /** Whether the working line's announcements may speak: once the first page has come back, while the session's listed. */
  workingReady?: boolean;
}

/** The Conversation tab's panel: the body that scrolls, which is also a Tab stop so the keyboard can scroll it. */
export function ConversationPanel({ conversation, id, labelledBy, hidden, role = 'tabpanel', emptyLine, missingLine, userSpeaker, working, workingReady = false }: ConversationPanelProps) {
  const { state, loadEarlier, retry, scroller, onScroll, onInput, sync, jumpToLatest, restorePlace, follow } = conversation;
  const rows = useMemo(() => conversationRows(state.entries), [state.entries]);
  // The calls of the folds that are open (conversation.ts: foldOpen). Every fold starts closed.
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggled = useRef(false);
  const toggle = useCallback((calls: KeyedEntry[]) => {
    toggled.current = true;
    setOpen((current) => toggleFold(current, calls));
  }, []);
  // Shown again, from behind the Terminal tab: the place the reader left, before it's painted.
  const wasHidden = useRef(hidden);
  useLayoutEffect(() => {
    if (wasHidden.current && !hidden) restorePlace();
    wasHidden.current = hidden;
  }, [hidden, restorePlace]);
  // A fold moves what's below it, not the scroll position, so the reader may be at the bottom now, or no longer.
  useLayoutEffect(() => {
    if (!toggled.current) return;
    toggled.current = false;
    sync();
  }, [open, sync]);

  const { entries } = state;
  // The working line, once a page is in (W102). It comes and goes, and a waiting line's text can wrap
  // to another line, without new entries: at the bottom, the conversation stays there.
  const line = working !== undefined && working.mode !== 'idle' && state.status === 'ready' ? working : undefined;
  const lineShape = line === undefined ? '' : line.mode === 'waiting' ? `waiting\u0000${line.text}\u0000${line.where ?? ''}` : 'working';
  useLayoutEffect(() => {
    follow();
  }, [lineShape, follow]);
  // The first page: "Loading the conversation…" after --pw-delay-spinner, and what's slow after --pw-delay-long.
  const waiting = useWaiting(scroller, state.status === 'loading');
  const status = statusLine(state, waiting.shown, { empty: emptyLine, missing: missingLine });
  return (
    <div
      className="session-view-body"
      role={role}
      id={id}
      aria-labelledby={labelledBy}
      // A Tab stop, so the conversation can be scrolled from the keyboard.
      tabIndex={0}
      ref={scroller}
      onScroll={onScroll}
      onWheel={onInput}
      onTouchStart={onInput}
      onPointerDown={onInput}
      onKeyDown={onInput}
      hidden={hidden}
    >
      {state.status === 'failed' && (
        <Alert
          key={`newest-${state.attempts.newest}`}
          tone="danger"
          role="alert"
          className="conversation-alert newest"
          actions={<TryAgain busy={state.retrying} onClick={retry} />}
        >
          {failedText('load the conversation', state.failure)}
        </Alert>
      )}
      {state.reloaded && (
        <Alert tone="neutral" role="status" className="conversation-alert">
          The transcript changed, so this starts again from its newest messages.
        </Alert>
      )}
      {state.earlierFailure !== undefined ? (
        // In Load earlier's place, until it works.
        <Alert
          key={`earlier-${state.attempts.earlier}`}
          tone="warning"
          role="alert"
          className="conversation-alert earlier"
          actions={<TryAgain busy={state.earlier === 'loading'} onClick={() => void loadEarlier()} />}
        >
          {failedText('load earlier messages', state.earlierFailure)}
        </Alert>
      ) : (
        state.before !== undefined && (
          <Button size="sm" className="load-earlier" busy={state.earlier === 'loading'} busyLabel="Loading earlier…" onClick={() => void loadEarlier()}>
            Load earlier
          </Button>
        )
      )}
      {rows.length > 0 && (
        <ol className="conversation">
          {rows.map((row) =>
            row.kind === 'fold' ? (
              <Fold key={row.key} calls={row.calls} open={foldOpen(open, row.calls)} onToggle={toggle} />
            ) : (
              <Entry key={row.key} entry={row.entry} userSpeaker={userSpeaker} />
            ),
          )}
        </ol>
      )}
      {line !== undefined && <WorkingLine line={line} />}
      {entries.length > 0 && state.failure !== undefined && (
        // At the end, where new entries would have come: what's shown is kept.
        <Alert
          key={`newest-${state.attempts.newest}`}
          tone="warning"
          role="alert"
          className="conversation-alert newest end"
          actions={<TryAgain busy={state.retrying} onClick={retry} />}
        >
          {failedText('refresh the conversation', state.failure, ', so it may be out of date.')}
        </Alert>
      )}
      {entries.length > 0 && state.status === 'missing' && (
        <Alert tone="neutral" role="status" className="conversation-alert end">
          The transcript is no longer available, so this is what it showed last.
        </Alert>
      )}
      <div className="conversation-status" role="status">
        {status !== undefined && <p className="status-line">{status}</p>}
        {state.status === 'loading' && waiting.long && <p className="status-line">Still waiting for the transcript…</p>}
      </div>
      {state.unseen > 0 && (
        // Sticky at the bottom of the body, taking no room of its own, so nothing moves when it goes.
        <div className="jump-latest">
          {/* It goes as it's used; focus on it moves to the panel first, so the keyboard carries on from there. */}
          <button type="button" className="jump-latest-button" onClick={jumpToLatest}>
            <Icon name="latest" />
            {state.unseen}
            {state.gap ? '+' : ''} new · Jump to latest
          </button>
        </div>
      )}
      {/* Once per batch that adds to the count, never per entry, and never the entries' text. */}
      <p className="visually-hidden" role="status">
        {state.unseen > 0 ? `${state.unseen}${state.gap ? '+' : ''} new` : ''}
      </p>
      {/* "Claude is working", "Finished" or the waiting text, once each (W102). */}
      {working !== undefined && <WorkingAnnouncer line={working} ready={workingReady} />}
    </div>
  );
}
