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
// - A fold stays open or closed across refreshes and "Load earlier" while it has a call it had.
// - Everything is text, never markup (6.1, rule 16).
//
// The loading, empty, failed and missing states are W28's, and keep their look here.

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { ConversationEntry } from '../../../src/shared/protocol.js';
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
import { clockTime, plainText } from '../format.js';
import { Badge } from './Badge.js';
import { Button } from './Button.js';
import { Icon } from './Icon.js';
import { Timestamp } from './Timestamp.js';
import { Tooltip } from './Tooltip.js';

/**
 * - `loading`: the first page hasn't arrived.
 * - `ready`: a page has arrived.
 * - `missing`: the server has no transcript for the session, or no longer lists it.
 * - `failed`: the first page couldn't be loaded.
 * - `unavailable`: there's no API client, as in tests that render the dashboard alone.
 */
type Status = 'loading' | 'ready' | 'missing' | 'failed' | 'unavailable';

interface ConversationState {
  status: Status;
  /** Oldest first. */
  entries: ConversationEntry[];
  /** The cursor for the page before the oldest entry shown. */
  before?: string;
  earlier: 'idle' | 'loading' | 'failed';
  /** The transcript changed under "Load earlier", so the view started again from the newest page. */
  reloaded: boolean;
  /** How many entries arrived while the reader was scrolled up: the count on "Jump to latest". */
  unseen: number;
}

/** Fetches one page of the session's conversation: the newest, or the one before `before`. Never rejects. */
export type PageLoader = (before?: string) => Promise<ConversationResult>;

type ScrollIntent = { kind: 'bottom' } | { kind: 'keep'; height: number; top: number };

/** How close to the bottom counts as at the bottom, for following new entries. */
export const AT_BOTTOM_PX = 24;

/** How long a smooth jump to the latest entry may take before the reader's scrolling counts again. */
const JUMP_MS = 1_500;

function isAtBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= AT_BOTTOM_PX;
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
  }));
  // The state as last committed, for the async loads to build on.
  const stateRef = useRef(state);
  // Bumped whenever the entries are replaced, so an older page asked for before then is dropped.
  const epoch = useRef(0);
  // Only the latest request for the newest page counts.
  const newestRequest = useRef(0);
  const alive = useRef(true);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
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

  /** At the bottom: nothing is unseen any more, and the bar goes. Focus on it moves to the panel first. */
  const reachedBottom = useCallback(() => {
    const current = stateRef.current;
    if (current.unseen === 0) return;
    const element = scroller.current;
    if (element && document.activeElement instanceof Element && document.activeElement.closest('.jump-latest') && element.contains(document.activeElement)) {
      element.focus({ preventScroll: true });
    }
    commit({ ...current, unseen: 0 });
  }, [commit]);

  const sync = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
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
        const merged = options.replace || current.status !== 'ready' ? undefined : mergeNewest(current.entries, result.page.entries);
        if (merged === undefined) {
          epoch.current += 1;
          scrollIntent.current = { kind: 'bottom' };
          commit(
            withBefore(
              { status: 'ready', entries: result.page.entries, earlier: 'idle', reloaded: options.reloaded === true, unseen: 0 },
              result.page.before,
            ),
          );
        } else if (atBottom.current) {
          scrollIntent.current = { kind: 'bottom' };
          commit({ ...current, entries: merged });
        } else {
          // Scrolled up: the place is kept, and what arrived is counted.
          commit({ ...current, entries: merged, unseen: current.unseen + countAdded(current.entries, merged) });
        }
      } else if (result.kind === 'not-found') {
        commit({ ...current, status: 'missing' });
      } else if (result.kind !== 'unauthorized' && current.status !== 'ready') {
        // A refresh that fails keeps what's on screen; the next change of activity tries again.
        commit({ ...current, status: 'failed' });
      }
      // On 'unauthorized' the app has already replaced the dashboard with the token notice.
    },
    [loader, commit],
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
      const element = scroller.current;
      if (element) scrollIntent.current = { kind: 'keep', height: element.scrollHeight, top: element.scrollTop };
      commit(withBefore({ ...latest, entries: prependOlder(result.page.entries, latest.entries), earlier: 'idle' }, result.page.before));
    } else if (result.kind === 'stale') {
      commit({ ...latest, earlier: 'idle' });
      await loadNewest({ replace: true, reloaded: true });
    } else {
      commit({ ...latest, earlier: result.kind === 'unauthorized' ? 'idle' : 'failed' });
    }
  }, [loader, commit, loadNewest]);

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
  useLayoutEffect(() => {
    const intent = scrollIntent.current;
    const element = scroller.current;
    scrollIntent.current = undefined;
    if (!intent || !element) return;
    element.scrollTop = intent.kind === 'bottom' ? element.scrollHeight : intent.top + (element.scrollHeight - intent.height);
    atBottom.current = isAtBottom(element);
  }, [state.entries]);

  // The scroller changes size without scrolling when the header or the message box below it grows or
  // shrinks (a send's result, a reply arriving, the box resized) and when the window does. Stay at the
  // bottom if already there; otherwise the place is kept, as the browser leaves scrollTop alone, and
  // the reader may have come to the bottom without scrolling.
  useEffect(() => {
    const element = scroller.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (atBottom.current) element.scrollTop = element.scrollHeight;
      else sync();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [sync]);

  const retry = useCallback(() => {
    commit({ ...stateRef.current, status: 'loading' });
    void loadNewest({ replace: true });
  }, [commit, loadNewest]);

  const jumpToLatest = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    endJump();
    atBottom.current = true;
    reachedBottom();
    const smooth = !prefersReducedMotion();
    if (smooth) jumping.current = setTimeout(endJump, JUMP_MS);
    if (typeof element.scrollTo === 'function') element.scrollTo({ top: element.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    else element.scrollTop = element.scrollHeight;
  }, [endJump, reachedBottom]);

  return { state, loadEarlier, retry, scroller, onScroll: sync, onInput: endJump, sync, jumpToLatest };
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
  const { state, loadEarlier, retry, scroller, onScroll, onInput, sync, jumpToLatest } = conversation;
  const rows = useMemo(() => conversationRows(state.entries), [state.entries]);
  // The calls of the folds that are open (conversation.ts: foldOpen). Every fold starts closed.
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggled = useRef(false);
  const toggle = useCallback((calls: KeyedEntry[]) => {
    toggled.current = true;
    setOpen((current) => toggleFold(current, calls));
  }, []);
  // A fold moves what's below it, not the scroll position, so the reader may be at the bottom now, or no longer.
  useLayoutEffect(() => {
    if (!toggled.current) return;
    toggled.current = false;
    sync();
  }, [open, sync]);

  const { entries } = state;
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
      {state.before !== undefined && (
        <Button size="sm" className="load-earlier" busy={state.earlier === 'loading'} busyLabel="Loading earlier…" onClick={() => void loadEarlier()}>
          Load earlier
        </Button>
      )}
      {state.earlier === 'failed' && <p className="session-view-status">Couldn&apos;t load earlier messages.</p>}
      {state.reloaded && <p className="session-view-status">The transcript changed, so this starts again from its newest messages.</p>}
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
      {state.status === 'loading' && (
        <p className="session-view-status" role="status">
          Loading the conversation…
        </p>
      )}
      {state.status === 'failed' && (
        <p className="session-view-status">
          Couldn&apos;t load the conversation.{' '}
          <button type="button" className="link-button" onClick={retry}>
            Try again
          </button>
        </p>
      )}
      {state.status === 'missing' && (
        <p className="session-view-status">{entries.length > 0 ? 'The transcript is no longer available.' : 'No transcript for this session.'}</p>
      )}
      {state.status === 'unavailable' && <p className="session-view-status">The conversation can&apos;t be loaded here.</p>}
      {state.status === 'ready' && entries.length === 0 && state.before === undefined && <p className="session-view-status">Nothing to show yet.</p>}
      {state.unseen > 0 && (
        // Sticky at the bottom of the body, taking no room of its own, so nothing moves when it goes.
        <div className="jump-latest">
          {/* It goes as it's used; focus on it moves to the panel first, so the keyboard carries on from there. */}
          <button type="button" className="jump-latest-button" onClick={jumpToLatest}>
            <Icon name="latest" />
            {state.unseen} new · Jump to latest
          </button>
        </div>
      )}
      {/* Once per batch that adds to the count, never per entry, and never the entries' text. */}
      <p className="visually-hidden" role="status">
        {state.unseen > 0 ? `${state.unseen} new` : ''}
      </p>
    </div>
  );
}
