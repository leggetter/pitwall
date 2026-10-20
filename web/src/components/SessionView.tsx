// The session view (docs/design-system.md, 3: Session view, and 4: Session view: header, tabs and
// footer): one session, as the third column from 1,200 px or over the session list below that. A
// header with its name and title, status, kind, last activity and directory, and the actions menu;
// the Conversation and Terminal tabs; the body, which is all that scrolls; and, for an interactive
// session, the message box in the footer.
//
// The conversation's internals are W27's and the terminal's W29's. The message box (RelayBox) and the
// inline confirmations (SessionActions, and the terminal's restart) are W24's; the tooltips, toasts
// and copy buttons are W25's.

import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import type { ConversationEntry, SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext } from '../api.js';
import { AttachContext, type AttachStatus } from '../attach.js';
import { entryKeys, getConversation, mergeNewest, prependOlder, type ConversationResult } from '../conversation.js';
import { COPIED, COPY_FAILED, selectText, useCopy } from '../copy.js';
import { absoluteTime, formatRoots, plainText, shortenHome } from '../format.js';
import { replyInConversation } from '../relay.js';
import { attachCommand, statusBadge } from '../sessions.js';
import { Alert } from './Alert.js';
import { StatusBadge } from './Badge.js';
import { Button } from './Button.js';
import { CopyButton } from './CopyButton.js';
import { Icon } from './Icon.js';
import { InfoTip } from './InfoTip.js';
import { MenuButton, type MenuEntry } from './Menu.js';
import { MiddleEllipsis } from './MiddleEllipsis.js';
import { RelayBox } from './RelayBox.js';
import { SessionConfirm, useSessionActions } from './SessionActions.js';
import { SESSION_VIEW_ID } from './SessionRow.js';
import { SessionTerminal, type RestartPhase } from './Terminal.js';
import { Timestamp } from './Timestamp.js';
import { useToast } from './Toast.js';
import { focusQuietly, Tooltip } from './Tooltip.js';

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

  const retry = useCallback(() => {
    commit({ ...stateRef.current, status: 'loading' });
    void loadNewest({ replace: true });
  }, [commit, loadNewest]);

  return { state, loadEarlier, retry, scroller, onScroll };
}

const TEXT_LABELS: Partial<Record<ConversationEntry['kind'], string>> = { user: 'You', assistant: 'Claude' };

const KIND_LABELS: Record<SessionSummary['kind'], string> = { interactive: 'Interactive', background: 'Background' };

/**
 * One entry, as text only: never markup. Line breaks are kept by CSS. Its time, and a tool call's
 * whole line, are still the browser's hover text: entries aren't focusable, and W27 rebuilds them,
 * with speaker lines that show the time and folded tool calls with their own tooltips.
 */
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


/** The interactive session's info icon: what /bg does. */
export const BG_NOTE = 'Typing /bg in its terminal moves it to the background, so pitwall can drive it fully.';
export const TERMINAL_INTERACTIVE_NOTE =
  "An interactive session can't be attached here. Typing /bg in its terminal moves it to the background, so pitwall can attach to it.";
export const CWD_MISSING_HINT = 'The working directory no longer exists, for example after a worktree was removed.';

/** How the view sits on the page (docs/design-system.md, 6.1 item 7). */
export type SessionViewLayout = 'column' | 'overlay';

/** Ignores keys with a modifier, and keys typed into a field. */
function plainKey(event: KeyboardEvent): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  const target = event.target;
  return !(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement);
}

interface FrameProps {
  layout: SessionViewLayout;
  /** Slide in, over the list: when it opens, not when it changes from one session to the next. */
  animate: boolean;
  titleId: string;
  /** Escape that nothing nearer handled: a menu, a dialog, the drawer, the filter or the terminal. The view decides the rest. */
  onEscape: () => void;
  children: ReactNode;
}

/**
 * The view's region: a <section> named by its heading, which is a non-modal dialog when it overlays
 * the list. It slides in when it opens over the list, but not when the window then crosses 1,200 px.
 */
function Frame({ layout, animate, titleId, onEscape, children }: FrameProps) {
  const [opening, setOpening] = useState(animate && layout === 'overlay');
  const onEscapeRef = useRef(onEscape);
  useEffect(() => {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  // Escape, last in the layered order (6.2): whatever nearer handled it called preventDefault.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onEscapeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <section
      id={SESSION_VIEW_ID}
      className={['session-view', layout === 'column' ? 'in-column' : 'overlay', opening && 'opening'].filter(Boolean).join(' ')}
      {...(layout === 'overlay' ? { role: 'dialog', 'aria-modal': false } : {})}
      aria-labelledby={titleId}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) setOpening(false);
      }}
    >
      {children}
    </section>
  );
}

interface TopProps {
  compact: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Between the heading and Close: the actions menu. */
  end?: ReactNode;
}

/** Line 1: Back at compact widths, the heading, then whatever goes at the end and Close. */
function Top({ compact, onClose, children, end }: TopProps) {
  return (
    <div className="session-view-top">
      {compact && (
        <button type="button" className="button ghost session-view-back" onClick={onClose} aria-keyshortcuts="Escape">
          <Icon name="back" />
          Back to sessions
        </button>
      )}
      {children}
      {end}
      {!compact && (
        <Tooltip content="Close" keys={{ keys: ['Esc'], label: 'Escape' }} relation="label">
          <button type="button" className="icon-button ghost md" aria-keyshortcuts="Escape" onClick={onClose}>
            <Icon name="close" />
          </button>
        </Tooltip>
      )}
    </div>
  );
}

export interface SessionViewProps {
  session: SessionSummary;
  /** False once the session has left the snapshot. The view keeps what it showed. */
  listed: boolean;
  onClose: () => void;
  /**
   * The third column, from 1,200 px: a region beside the list. Otherwise, as below 1,200 px, a
   * non-modal dialog over the list (docs/design-system.md, 6.1).
   */
  layout?: SessionViewLayout;
  /** 600 px and narrower: "Back to sessions" at the start of the header, in place of Close. */
  compact?: boolean;
  /** The heading, which takes focus when the view is opened from a row. */
  headingRef?: RefObject<HTMLHeadingElement | null>;
  /** ↑ and ↓ in the header: the previous or next session in the session list. */
  onStep?: ((step: 1 | -1) => void) | undefined;
  /** Slide in when it opens over the list. False when it takes over from another session's view. */
  animate?: boolean;
  /** Whether the message box has a draft, for the shortcuts that would replace or close the view (6.2). */
  onDraftChange?: ((hasDraft: boolean) => void) | undefined;
}

type Tab = 'conversation' | 'terminal';

/** A copy from the actions menu that the clipboard refused: the text isn't on screen, so the header shows it. */
type Refused = { label: string; text: string };

export function SessionView({ session, listed, onClose, layout = 'overlay', compact = false, headingRef, onStep, animate = true, onDraftChange }: SessionViewProps) {
  const api = useContext(ApiContext);
  const attachEnv = useContext(AttachContext);
  const ids = { title: useId(), conversationTab: useId(), conversationPanel: useId(), terminalTab: useId(), terminalPanel: useId() };
  const ownHeading = useRef<HTMLHeadingElement>(null);
  const heading = headingRef ?? ownHeading;
  const menuButton = useRef<HTMLButtonElement>(null);
  const conversationTab = useRef<HTMLButtonElement>(null);
  const terminalTab = useRef<HTMLButtonElement>(null);
  const pathRef = useRef<HTMLSpanElement>(null);
  const fallbackRef = useRef<HTMLElement>(null);
  const alive = useRef(true);
  // Aborted when the view closes, so a request still waiting for an apiKey doesn't outlive it.
  const requests = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    requests.current = controller;
    return () => {
      alive.current = false;
      controller.abort();
    };
  }, []);
  const { sessionId } = session;
  const loader = useMemo<PageLoader | undefined>(
    () => (api ? (before) => getConversation(api, sessionId, before, requests.current?.signal) : undefined),
    [api, sessionId],
  );
  const { state, loadEarlier, retry, scroller, onScroll } = useConversation(session.lastActivityAt, loader);
  const actions = useSessionActions(session, onClose);
  const [tab, setTab] = useState<Tab>('conversation');
  const [attachStatus, setAttachStatus] = useState<AttachStatus>();
  // The terminal's restart confirmation, open or busy, for Escape's layering.
  const [restart, setRestart] = useState<RestartPhase>();
  // Whether the message box has a draft: Escape never closes the view then (6.2).
  const draft = useRef(false);
  const copyText = useCopy();
  const toast = useToast();
  const [refused, setRefused] = useState<Refused>();

  // A refused copy's text, shown under line 2, is selected so it can be copied by hand. It stays until the next copy.
  useEffect(() => {
    if (refused) selectText(fallbackRef.current);
  }, [refused]);

  /** The actions menu's copies, inside the click or key that chose them, as Safari requires (4: Copy). */
  const copy = (label: string, text: string) => {
    setRefused(undefined);
    void copyText(text).then((ok) => {
      if (!alive.current) return;
      if (ok) toast({ tone: 'success', message: COPIED });
      else {
        setRefused({ label, text });
        toast({ tone: 'error', message: COPY_FAILED });
      }
    });
  };

  // An interactive session, or a background one that can't be attached from here.
  const background = session.kind === 'background';
  const terminalOff = !background
    ? TERMINAL_INTERACTIVE_NOTE
    : !attachEnv
      ? 'Attach is unavailable here.'
      : !listed
        ? "It's no longer listed, so it can't be attached."
        : undefined;

  /** Opening Terminal attaches; for a session that isn't running, the terminal first asks to restart it (D9). */
  const openTab = (next: Tab) => {
    if (next === 'terminal' && terminalOff) return;
    setTab(next);
    // Switching to Conversation unmounts the terminal, which detaches.
    if (next === 'conversation') setAttachStatus(undefined);
  };

  /** Detach, Cancel on the restart, or Back to the conversation: the conversation, with focus on the Terminal tab. */
  const leaveTerminal = useCallback(() => {
    setTab('conversation');
    setAttachStatus(undefined);
    terminalTab.current?.focus();
  }, []);

  // Escape from anywhere a nearer layer didn't take it (6.2): a confirmation cancels, and a busy one, or
  // a draft in the message box, keeps the view open. Otherwise the view closes.
  const onEscape = () => {
    if (actions.running) return;
    if (actions.confirming) {
      actions.cancel();
      focusQuietly(menuButton.current);
    } else if (tab === 'terminal' && restart === 'asking') {
      leaveTerminal();
    } else if ((tab === 'terminal' && restart === 'restarting') || draft.current) {
      // Nothing to cancel: the restart is out, or there's a draft to keep.
    } else {
      onClose();
    }
  };

  // ← and → (and Home and End) move focus between the tabs; Enter or Space opens one, never focus alone.
  const onTabsKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const tabs = [conversationTab.current, terminalTab.current];
    const at = tabs.indexOf(document.activeElement as HTMLButtonElement);
    const to =
      event.key === 'ArrowRight' || event.key === 'ArrowLeft'
        ? (at + 1) % tabs.length
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? tabs.length - 1
            : undefined;
    if (to === undefined) return;
    event.preventDefault();
    tabs[to]?.focus();
  };

  const onHeaderKey = (event: KeyboardEvent<HTMLElement>) => {
    if (!onStep || event.defaultPrevented || !plainKey(event)) return;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    onStep(event.key === 'ArrowDown' ? 1 : -1);
  };

  const badge = statusBadge(session);
  const name = plainText(session.name);
  const title = session.title ? plainText(session.title) : '';
  const cwd = plainText(session.cwd);
  const command = attachCommand(session);
  const canAct = background && listed;
  const busy = actions.running !== undefined;
  const entries: MenuEntry[] = [
    { id: 'copy-id', label: 'Copy session ID', icon: 'copy', onSelect: () => copy('Session ID', sessionId) },
    ...(command ? [{ id: 'copy-attach', label: 'Copy attach command', icon: 'terminal' as const, onSelect: () => copy('Attach command', command) }] : []),
    ...(canAct
      ? [
          { kind: 'separator' as const, id: 'separator' },
          {
            id: 'stop',
            label: 'Stop session',
            icon: 'stop' as const,
            disabled: busy || !session.alive,
            hint: busy ? 'Wait for the current action to finish.' : "It isn't running, so there's nothing to stop.",
            onSelect: () => actions.ask('stop'),
          },
          {
            id: 'remove',
            label: 'Remove session',
            icon: 'remove' as const,
            danger: true,
            disabled: busy,
            hint: 'Wait for the current action to finish.',
            onSelect: () => actions.ask('remove'),
          },
        ]
      : []),
  ];
  const { entries: conversation } = state;
  const keys = entryKeys(conversation);
  // Shown once: the footer leaves out a reply the conversation already has.
  const replyShown = useMemo(() => (session.relay ? replyInConversation(session.relay, conversation) : false), [session.relay, conversation]);
  const attached = tab === 'terminal' && attachStatus?.kind === 'attached';

  return (
    <Frame layout={layout} animate={animate} titleId={ids.title} onEscape={onEscape}>
      <header className="session-view-head" onKeyDown={onHeaderKey}>
        <Top
          compact={compact}
          onClose={onClose}
          end={<MenuButton label="Session actions" icon="more" entries={entries} buttonRef={menuButton} />}
        >
          {/* Focused when the view opens from a row, with no ring of its own (6.1, item 8). */}
          <h2 className="session-view-title" id={ids.title} ref={heading} tabIndex={-1}>
            <span className="session-view-name">{name}</span>
            {title && (
              // The " · " is drawn with the title, so it goes when the title has given way. Screen
              // readers get it from the hidden text instead. The whole title is in a tooltip when it's cut.
              <Tooltip content={title} relation="none" onlyIfCut>
                <span className="session-view-subtitle">
                  <span className="visually-hidden"> · </span>
                  {title}
                </span>
              </Tooltip>
            )}
          </h2>
        </Top>
        <div className="session-view-meta">
          {/* Idle shows here, though not in the list. */}
          <StatusBadge badge={badge} />
          <span className="session-view-kind">
            {KIND_LABELS[session.kind]}
            {/* A button, so Tab reaches it: its name is the note, which is also its tooltip. */}
            {!background && <InfoTip text={BG_NOTE} className="session-view-info" />}
          </span>
          {session.lastActivityAt && <Timestamp className="session-view-activity" at={session.lastActivityAt} prefix="Active " />}
          <span className="session-view-cwd">
            {/* The whole path, home and all: on screen, home is ~ and the middle may be cut. */}
            <Tooltip content={cwd} relation="none" onlyIfCut={shortenHome(cwd) === cwd}>
              <span className="session-view-path" ref={pathRef}>
                <MiddleEllipsis text={shortenHome(cwd)} />
              </span>
            </Tooltip>
            <CopyButton text={session.cwd} label="Copy path" target={pathRef} />
          </span>
          {session.cwdMissing && (
            // Its own item, so it wraps to the next line rather than squeezing the path.
            <Tooltip content={CWD_MISSING_HINT} relation="none">
              <span className="session-view-missing">Directory no longer exists</span>
            </Tooltip>
          )}
        </div>
        {refused && (
          <p className="session-view-copy-fallback">
            {refused.label}: <code ref={fallbackRef}>{plainText(refused.text)}</code>
          </p>
        )}
        {!listed && (
          <Alert tone="neutral" role="status">
            This session is no longer listed, so this is what it showed last.
          </Alert>
        )}
      </header>

      {canAct && <SessionConfirm actions={actions} onReturnFocus={() => focusQuietly(menuButton.current)} />}

      <div className="session-tabs" role="tablist" aria-label="Session view" onKeyDown={onTabsKey}>
        <button
          ref={conversationTab}
          type="button"
          role="tab"
          id={ids.conversationTab}
          className="session-tab"
          aria-selected={tab === 'conversation'}
          aria-controls={ids.conversationPanel}
          tabIndex={tab === 'conversation' ? 0 : -1}
          onClick={() => openTab('conversation')}
        >
          <Icon name="conversation" />
          Conversation
        </button>
        {/* Disabled, it says why in a tooltip, which describes it. */}
        <Tooltip content={terminalOff} relation="description">
          <button
            ref={terminalTab}
            type="button"
            role="tab"
            id={ids.terminalTab}
            className="session-tab"
            aria-selected={tab === 'terminal'}
            aria-controls={ids.terminalPanel}
            aria-disabled={terminalOff !== undefined || undefined}
            tabIndex={tab === 'terminal' ? 0 : -1}
            onClick={() => openTab('terminal')}
          >
            <Icon name="terminal" />
            Terminal
            {attached && (
              <>
                <span className="session-tab-dot" aria-hidden="true" />
                <span className="visually-hidden">, attached</span>
              </>
            )}
          </button>
        </Tooltip>
      </div>

      <div
        className="session-view-body"
        role="tabpanel"
        id={ids.conversationPanel}
        aria-labelledby={ids.conversationTab}
        // A Tab stop, so the conversation can be scrolled from the keyboard.
        tabIndex={0}
        ref={scroller}
        onScroll={onScroll}
        hidden={tab !== 'conversation'}
      >
        {state.before !== undefined && (
          <Button size="sm" className="load-earlier" busy={state.earlier === 'loading'} busyLabel="Loading earlier…" onClick={() => void loadEarlier()}>
            Load earlier
          </Button>
        )}
        {state.earlier === 'failed' && <p className="session-view-status">Couldn&apos;t load earlier messages.</p>}
        {state.reloaded && (
          <p className="session-view-status">The transcript changed, so this starts again from its newest messages.</p>
        )}
        {conversation.length > 0 && (
          <ol className="conversation">
            {conversation.map((entry, index) => (
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
            {conversation.length > 0 ? 'The transcript is no longer available.' : 'No transcript for this session.'}
          </p>
        )}
        {state.status === 'unavailable' && <p className="session-view-status">The conversation can&apos;t be loaded here.</p>}
        {state.status === 'ready' && conversation.length === 0 && state.before === undefined && (
          <p className="session-view-status">Nothing to show yet.</p>
        )}
      </div>

      <div
        className="session-view-terminal"
        role="tabpanel"
        id={ids.terminalPanel}
        aria-labelledby={ids.terminalTab}
        hidden={tab !== 'terminal'}
      >
        {tab === 'terminal' && (
          <SessionTerminal sessionId={sessionId} onClose={leaveTerminal} onStatus={setAttachStatus} onRestartChange={setRestart} />
        )}
      </div>

      {session.kind === 'interactive' && listed && (
        <footer className="session-view-foot">
          <RelayBox
            session={session}
            replyShown={replyShown}
            onDraftChange={(has) => {
              draft.current = has;
              onDraftChange?.(has);
            }}
          />
        </footer>
      )}
    </Frame>
  );
}

/** At most this much of an unknown id from the URL is shown. */
const ID_SHOWN = 120;

export interface UnlistedSessionViewProps {
  /** The id from ?session=, which isn't in the snapshot. */
  sessionId: string;
  roots: readonly string[];
  onClose: () => void;
  layout?: SessionViewLayout;
  compact?: boolean;
  headingRef?: RefObject<HTMLHeadingElement | null>;
  animate?: boolean;
}

/**
 * A URL's ?session= that isn't listed under these roots (3: Session view), and wasn't while this page
 * was open: there's nothing to show, so the view says so and offers Close. It never attaches, sends
 * or changes anything.
 */
export function UnlistedSessionView({ sessionId, roots, onClose, layout = 'overlay', compact = false, headingRef, animate = true }: UnlistedSessionViewProps) {
  const titleId = useId();
  const id = plainText(sessionId);
  const shown = id.length > ID_SHOWN ? `${id.slice(0, ID_SHOWN)}…` : id;
  return (
    <Frame layout={layout} animate={animate} titleId={titleId} onEscape={onClose}>
      <header className="session-view-head">
        <Top compact={compact} onClose={onClose}>
          <h2 className="session-view-title" id={titleId} ref={headingRef} tabIndex={-1}>
            <span className="session-view-name wrap">This session isn&apos;t listed under these roots</span>
          </h2>
        </Top>
      </header>
      <div className="session-view-body">
        <p className="session-view-status unlisted">
          pitwall lists no session with the id <code>{shown}</code> under {plainText(formatRoots(roots))}. It may have been removed,
          or it may run outside these roots.
        </p>
      </div>
    </Frame>
  );
}
