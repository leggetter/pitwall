import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ConversationEntry, SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext } from '../api.js';
import { entryKeys, getConversation, mergeNewest, prependOlder, type ConversationResult } from '../conversation.js';
import { absoluteTime, plainText, relativeTime, shortenHome } from '../format.js';
import { statusPill } from '../sessions.js';
import { RelayBox } from './RelayBox.js';
import { SessionActions } from './SessionActions.js';
import { SessionTerminal, useAttachToggle } from './Terminal.js';

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
}

/** Fetches one page of the session's conversation: the newest, or the one before `before`. Never rejects. */
type PageLoader = (before?: string) => Promise<ConversationResult>;

type ScrollIntent = { kind: 'bottom' } | { kind: 'keep'; height: number; top: number };

/** How close to the bottom counts as at the bottom, for following new entries. */
const AT_BOTTOM_PX = 24;

function isAtBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= AT_BOTTOM_PX;
}

function withBefore(state: ConversationState, before: string | undefined): ConversationState {
  const { before: _old, ...rest } = state;
  return before === undefined ? rest : { ...rest, before };
}

/**
 * A session's conversation: the newest page when the view opens, merged again
 * whenever the session's activity time moves, and older pages on request.
 */
function useConversation(lastActivityAt: string | undefined, loader: PageLoader | undefined) {
  const [state, setState] = useState<ConversationState>(() => ({
    status: loader ? 'loading' : 'unavailable',
    entries: [],
    earlier: 'idle',
    reloaded: false,
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

  const commit = useCallback((next: ConversationState) => {
    stateRef.current = next;
    setState(next);
  }, []);

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
              { status: 'ready', entries: result.page.entries, earlier: 'idle', reloaded: options.reloaded === true },
              result.page.before,
            ),
          );
        } else {
          if (atBottom.current) scrollIntent.current = { kind: 'bottom' };
          commit({ ...current, entries: merged });
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
  // bottom if already there; otherwise the place is kept, as the browser leaves scrollTop alone.
  useEffect(() => {
    const element = scroller.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (atBottom.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const onScroll = useCallback(() => {
    if (scroller.current) atBottom.current = isAtBottom(scroller.current);
  }, []);

  /** To the newest entry, and following new ones from there. */
  const scrollToBottom = useCallback(() => {
    atBottom.current = true;
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, []);

  const retry = useCallback(() => {
    commit({ ...stateRef.current, status: 'loading' });
    void loadNewest({ replace: true });
  }, [commit, loadNewest]);

  return { state, loadEarlier, retry, scroller, onScroll, scrollToBottom };
}

const TEXT_LABELS: Partial<Record<ConversationEntry['kind'], string>> = { user: 'You', assistant: 'Claude' };

/** One entry, as text only: never markup. Line breaks are kept by CSS. */
function Entry({ entry }: { entry: ConversationEntry }) {
  const when = entry.at ? absoluteTime(entry.at) : undefined;
  const text = plainText(entry.text);
  if (entry.kind === 'tool') {
    return (
      <li className={entry.toolError ? 'entry entry-tool has-error' : 'entry entry-tool'} title={when ? `${text}\n${when}` : text}>
        <span className="entry-tool-text">{text}</span>
        {entry.toolError && <span className="tool-error">error</span>}
      </li>
    );
  }
  const label = entry.kind === 'cross-session' ? `From ${plainText(entry.from ?? 'another session')}` : TEXT_LABELS[entry.kind];
  return (
    <li className={`entry entry-${entry.kind}`} title={when}>
      {label && <p className="entry-label">{label}</p>}
      <p className="entry-text">{text}</p>
      {entry.truncated && <p className="entry-note">Cut short.</p>}
    </li>
  );
}

export interface SessionViewProps {
  session: SessionSummary;
  /** False once the session has left the snapshot. The view keeps what it showed. */
  listed: boolean;
  now: number;
  onClose: () => void;
  /**
   * The third column, from 1,200 px: a region beside the list. Otherwise, as below 1,200 px, a
   * non-modal dialog over the list (docs/design-system.md, 6.1).
   */
  layout?: 'column' | 'overlay';
}

/**
 * One session's conversation, in the third column or a panel over the right of the page: the
 * header at the top, the conversation scrolling in the middle and, for an
 * interactive session, the message box pinned below the newest message.
 * Closes with its button or Escape.
 */
export function SessionView({ session, listed, now, onClose, layout = 'overlay' }: SessionViewProps) {
  const api = useContext(ApiContext);
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  // Aborted when the view closes, so a request still waiting for an apiKey doesn't outlive it.
  const requests = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    requests.current = controller;
    return () => controller.abort();
  }, []);
  const { sessionId } = session;
  const loader = useMemo<PageLoader | undefined>(
    () => (api ? (before) => getConversation(api, sessionId, before, requests.current?.signal) : undefined),
    [api, sessionId],
  );
  const { state, loadEarlier, retry, scroller, onScroll, scrollToBottom } = useConversation(session.lastActivityAt, loader);
  // Background sessions can be attached (W10). The terminal takes the conversation's place until it's closed.
  const attach = useAttachToggle(session.kind);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Escape closes the view from anywhere on the page.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const pill = statusPill(session);
  const name = plainText(session.name);
  const title = session.title ? plainText(session.title) : '';
  const { entries } = state;
  const keys = entryKeys(entries);

  return (
    <section
      className={layout === 'column' ? 'session-view in-column' : 'session-view'}
      {...(layout === 'overlay' ? { role: 'dialog', 'aria-modal': false } : {})}
      aria-labelledby={titleId}
    >
      <header className="session-view-head">
        <div className="session-view-top">
          <h2 className="session-view-title" id={titleId}>
            {name}
            {title && (
              <>
                <span className="session-title-sep"> · </span>
                <span className="session-view-subtitle">{title}</span>
              </>
            )}
          </h2>
          {attach.available && !attach.open && (
            <button ref={attach.buttonRef} type="button" className="button small" onClick={attach.show}>
              Attach
            </button>
          )}
          <button ref={closeRef} type="button" className="button small" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="session-view-meta">
          <span className="kind">{session.kind}</span>
          <span className={`pill tone-${pill.tone}`}>{plainText(pill.label)}</span>
          {session.lastActivityAt && (
            <time className="activity" dateTime={session.lastActivityAt} title={absoluteTime(session.lastActivityAt)}>
              active {relativeTime(session.lastActivityAt, now)}
            </time>
          )}
        </div>
        <p className="session-view-cwd" title={plainText(session.cwd)}>
          {plainText(shortenHome(session.cwd))}
        </p>
        {session.kind === 'background' && listed && <SessionActions session={session} onRemoved={onClose} />}
        {session.kind === 'interactive' && (
          <p className="session-view-note">
            Typing <code>/bg</code> in this session&apos;s terminal moves it to the background, which will let pitwall
            drive it fully from here.
          </p>
        )}
        {!listed && <p className="session-view-note">This session is no longer listed, so this is what it showed last.</p>}
      </header>

      {attach.open && <SessionTerminal sessionId={sessionId} onClose={attach.hide} />}
      <div className="session-view-body" ref={scroller} onScroll={onScroll} hidden={attach.open}>
        {state.before !== undefined && (
          <button
            type="button"
            className="button small load-earlier"
            onClick={() => void loadEarlier()}
            disabled={state.earlier === 'loading'}
            aria-busy={state.earlier === 'loading' || undefined}
          >
            {state.earlier === 'loading' ? 'Loading earlier…' : 'Load earlier'}
          </button>
        )}
        {state.earlier === 'failed' && <p className="session-view-status">Couldn&apos;t load earlier messages.</p>}
        {state.reloaded && (
          <p className="session-view-status">The transcript changed, so this starts again from its newest messages.</p>
        )}
        {entries.length > 0 && (
          <ol className="conversation">
            {entries.map((entry, index) => (
              <Entry key={keys[index]} entry={entry} />
            ))}
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
          <p className="session-view-status">
            {entries.length > 0 ? 'The transcript is no longer available.' : 'No transcript for this session.'}
          </p>
        )}
        {state.status === 'unavailable' && <p className="session-view-status">The conversation can&apos;t be loaded here.</p>}
        {state.status === 'ready' && entries.length === 0 && state.before === undefined && (
          <p className="session-view-status">Nothing to show yet.</p>
        )}
      </div>

      {session.kind === 'interactive' && listed && (
        <footer className="session-view-foot">
          <RelayBox session={session} now={now} onFocusRequest={scrollToBottom} />
        </footer>
      )}
    </section>
  );
}
