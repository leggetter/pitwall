// The session view's conversation (docs/design-system.md, 4: Conversation): the Conversation tab's
// panel, which is the view's scrolling body. An <ol> of entries, oldest first, opening scrolled to the
// newest: your messages, Claude's, messages from other sessions and notices, each text entry with its
// speaker line and time, and tool calls, two or more in a row folded into one toggle.
//
// - The newest page is fetched when the view opens, and again whenever the session's activity time
//   moves; it's merged onto the end without duplicating an entry (conversation.ts). Older pages come
//   from "Load earlier", and the reader's place holds as they arrive above it.
// - At the bottom, new entries keep it there. Scrolled up, the place is kept, and "n new · Jump to
//   latest" sticks to the bottom of the body until the reader gets there by any means. Each batch
//   that adds to the count is announced once, as "n new", never the entries' text.
// - Behind the Terminal tab, the panel is hidden (display: none), which leaves it no size and lets the
//   browser drop its scroll position. Nothing counts as the reader's place while it's hidden, and
//   shown again it goes back to the place they left, or to the bottom if they were there (W29).
// - A fold stays open or closed across refreshes and "Load earlier" while it has a call it had.
// - Everything is text, never markup (6.1, rule 16).
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

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import type { ConversationEntry, ConversationPage } from '../../../src/shared/protocol.js';
import {
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
import { Timestamp } from './Timestamp.js';
import { Tooltip } from './Tooltip.js';
import { useWaiting } from './Waiting.js';

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
}

/**
 * A session's conversation: the newest page when the view opens, merged again whenever the session's
 * activity time moves, and older pages on request. It follows new entries only while the reader is at
 * the bottom, and counts those that arrive while they aren't.
 */
export function useConversation(lastActivityAt: string | undefined, loader: PageLoader | undefined): ConversationController {
  const [state, setState] = useState<ConversationState>(() => ({
    status: loader ? 'loading' : 'unavailable',
    entries: [],
    earlier: 'idle',
    reloaded: false,
    unseen: 0,
    gap: false,
    retrying: false,
  }));
  // The newest page, while it waits behind "Jump to latest" because it doesn't meet what's shown (`gap`).
  const waitingPage = useRef<ConversationPage | undefined>(undefined);
  // The state as last committed, for the async loads to build on.
  const stateRef = useRef(state);
  // Bumped whenever the entries are replaced, so an older page asked for before then is dropped.
  const epoch = useRef(0);
  // Only the latest request for the newest page counts.
  const newestRequest = useRef(0);
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
    commit(withBefore({ status: 'ready', entries: waiting.entries, earlier: 'idle', reloaded: false, unseen: 0, gap: false, retrying: false }, waiting.before));
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
      const result = await loader();
      if (!alive.current || request !== newestRequest.current) return;
      const current = stateRef.current;
      if (result.kind === 'ok') {
        if (current.failure !== undefined) keepFocus();
        const settled = withFailure({ ...current, retrying: false }, 'failure', undefined);
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
            withBefore(
              { status: 'ready', entries: result.page.entries, earlier: 'idle', reloaded: options.reloaded === true, unseen: 0, gap: false, retrying: false },
              result.page.before,
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
        if (current.entries.length > 0) {
          // A refresh that fails keeps what's on screen, and says it may be out of date, at the end,
          // where the reader at the bottom sees it. The next change of activity, or Try again, tries again.
          if (atBottom.current) scrollIntent.current = { kind: 'bottom' };
          commit(withFailure({ ...current, retrying: false }, 'failure', failureOf(result)));
        } else {
          commit(withFailure({ ...current, status: 'failed', retrying: false }, 'failure', failureOf(result)));
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
      commit(withFailure({ ...latest, earlier: 'failed' }, 'earlierFailure', failure));
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

  // Follow new entries only when already at the bottom; keep the place when older ones arrive above.
  // A notice or an alert at the end, at the bottom, is followed the same way.
  useLayoutEffect(() => {
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

  return { state, loadEarlier, retry, scroller, onScroll: sync, onInput: endJump, sync, jumpToLatest, restorePlace };
}

/** "n tool calls", "1 error", "n errors". */
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** A tool call's one line, cut with an ellipsis, the whole of it in a tooltip when it's cut, and its error badge. */
function ToolCall({ entry }: { entry: ConversationEntry }) {
  const text = plainText(entry.text);
  return (
    <>
      {/* Never focusable, so it opens on hover; the whole line is in the DOM for screen readers and find. */}
      <Tooltip content={text} relation="none" onlyIfCut>
        <span className="tool-call-text">{text}</span>
      </Tooltip>
      {entry.toolError && (
        <Badge look="subtle-danger" className="tool-call-error">
          error
        </Badge>
      )}
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

const SPEAKERS: Partial<Record<ConversationEntry['kind'], string>> = { user: 'You', assistant: 'Claude' };

/** One entry that isn't folded, as text only: never markup. Line breaks are kept by CSS. */
function Entry({ entry }: { entry: ConversationEntry }) {
  if (entry.kind === 'tool') {
    return (
      <li className={entry.toolError ? 'entry entry-tool has-error' : 'entry entry-tool'}>
        <ToolCall entry={entry} />
      </li>
    );
  }
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
  const speaker = entry.kind === 'cross-session' ? `From ${plainText(entry.from ?? 'another session')}` : SPEAKERS[entry.kind];
  const time = entry.at !== undefined && clockTime(entry.at) !== undefined ? entry.at : undefined;
  return (
    <li className={`entry entry-${entry.kind}`}>
      <p className="entry-speaker">
        {speaker}
        {time !== undefined && (
          <span className="entry-time">
            {' · '}
            <Timestamp at={time} format="time" />
          </span>
        )}
      </p>
      <p className="entry-text">{text}</p>
      {cut}
    </li>
  );
}

/**
 * pitwall's sentence for a failed load, then the server's reason as text when it gave one, or else
 * the HTTP status before the full stop, as the session actions do (5: Errors).
 */
function failedText(what: string, failure: LoadFailure | undefined, after = ''): ReactNode {
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
function TryAgain({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <Button size="sm" icon="retry" busy={busy} busyLabel="Trying again…" onClick={onClick}>
      Try again
    </Button>
  );
}

/** The conversation's status line, a role="status" that's always there: what's loading, or why there's nothing. */
function statusLine(state: ConversationState, shown: boolean): string | undefined {
  const empty = state.entries.length === 0;
  switch (state.status) {
    case 'loading':
      return shown ? 'Loading the conversation…' : undefined;
    case 'missing':
      return empty ? 'No transcript for this session.' : undefined;
    case 'unavailable':
      return "The conversation can't be loaded here.";
    case 'ready':
      return empty && state.before === undefined ? 'Nothing to show yet.' : undefined;
    case 'failed':
      return undefined;
  }
}

export interface ConversationPanelProps {
  conversation: ConversationController;
  /** The tab panel's id, which the Conversation tab controls. */
  id: string;
  /** The Conversation tab's id, which names the panel. */
  labelledBy: string;
  hidden: boolean;
}

/** The Conversation tab's panel: the body that scrolls, which is also a Tab stop so the keyboard can scroll it. */
export function ConversationPanel({ conversation, id, labelledBy, hidden }: ConversationPanelProps) {
  const { state, loadEarlier, retry, scroller, onScroll, onInput, sync, jumpToLatest, restorePlace } = conversation;
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
  // The first page: "Loading the conversation…" after --pw-delay-spinner, and what's slow after --pw-delay-long.
  const waiting = useWaiting(scroller, state.status === 'loading');
  const line = statusLine(state, waiting.shown);
  return (
    <div
      className="session-view-body"
      role="tabpanel"
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
        <Alert tone="danger" role="alert" className="conversation-alert" actions={<TryAgain busy={state.retrying} onClick={retry} />}>
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
          tone="warning"
          role="alert"
          className="conversation-alert"
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
              <Entry key={row.key} entry={row.entry} />
            ),
          )}
        </ol>
      )}
      {entries.length > 0 && state.failure !== undefined && (
        // At the end, where new entries would have come: what's shown is kept.
        <Alert tone="warning" role="alert" className="conversation-alert end" actions={<TryAgain busy={state.retrying} onClick={retry} />}>
          {failedText('refresh the conversation', state.failure, ', so it may be out of date.')}
        </Alert>
      )}
      {entries.length > 0 && state.status === 'missing' && (
        <Alert tone="neutral" role="status" className="conversation-alert end">
          The transcript is no longer available, so this is what it showed last.
        </Alert>
      )}
      <div className="conversation-status" role="status">
        {line !== undefined && <p className="status-line">{line}</p>}
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
    </div>
  );
}
