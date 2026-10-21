// The session view (docs/design-system.md, 3: Session view, and 4: Session view: header, tabs and
// footer): one session, as the third column from 1,200 px or over the session list below that. A
// header with its name and title, status, kind, last activity and directory, where it started and
// the repos it worked in when there are any (W34), and the actions menu;
// the Conversation and Terminal tabs; the body, which is all that scrolls; and, for an interactive
// session, the message box in the footer.
//
// Two more states take the view's place: waiting, while a ?session= from the URL waits for the first
// snapshot, and unlisted, for one that pitwall doesn't list under its roots (3: Session view).
//
// With root tabs (W38), each tab keeps its own open session, and the views of the tabs that aren't
// open stay mounted, hidden, so switching tabs never detaches a terminal, drops a draft, or stops a
// send or an action in flight. A hidden view has no id and ignores Escape, and its conversation keeps
// the reader's place, as it does behind the Terminal tab.
//
// The conversation is its own component (Conversation.tsx, W27), and the terminal's internals are
// W29's. The message box (RelayBox) and the inline confirmations (SessionActions, and the terminal's
// restart) are W24's; the tooltips, toasts and copy buttons are W25's.

import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import type { SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext } from '../api.js';
import { AttachContext, type AttachStatus } from '../attach.js';
import { getConversation } from '../conversation.js';
import { COPIED, COPY_FAILED, selectText, useCopy } from '../copy.js';
import { formatRoots, plainText, shortenHome } from '../format.js';
import { PANEL_MENU_STEP, PANEL_MIN, panelLimits, panelReset, shownPanel, type PanelWidthStore } from '../panelWidth.js';
import { replyInConversation } from '../relay.js';
import { attachCommand, statusBadge } from '../sessions.js';
import { moveTabFocus } from '../tabs.js';
import { Alert } from './Alert.js';
import { Badge, StatusBadge } from './Badge.js';
import { Button } from './Button.js';
import { ConversationPanel, useConversation, type PageLoader } from './Conversation.js';
import { CopyButton } from './CopyButton.js';
import { EmptyState } from './EmptyState.js';
import { Icon } from './Icon.js';
import { InfoTip } from './InfoTip.js';
import { MenuButton, type MenuEntry } from './Menu.js';
import { MiddleEllipsis } from './MiddleEllipsis.js';
import { RelayBox } from './RelayBox.js';
import { SessionConfirm, useSessionActions } from './SessionActions.js';
import { FINISHED_ASKED_HINT, SESSION_VIEW_ID, STALE_HINT } from './SessionRow.js';
import { SessionTerminal, type RestartPhase } from './Terminal.js';
import { Timestamp } from './Timestamp.js';
import { useToast } from './Toast.js';
import { focusQuietly, Tooltip } from './Tooltip.js';
import { SkeletonHeading, SkeletonMeta, WaitingStatus, type Waiting } from './Waiting.js';

const KIND_LABELS: Record<SessionSummary['kind'], string> = { interactive: 'Interactive', background: 'Background' };

/** The interactive session's info icon: what /bg does, which the disabled Terminal tab and Stop session each say how to use. */
export const BG_NOTE = 'Typing /bg in its terminal moves it to the background, so pitwall can attach to it and stop it.';
/** The Terminal tab's tooltip for an interactive session, where the tab is off. */
export const TERMINAL_INTERACTIVE_NOTE =
  "An interactive session can't be attached here. Type /bg in its terminal to move it to the background, then attach to it here.";
/** Stop session's tooltip for an interactive session, where the item is off (W40). */
export const STOP_INTERACTIVE_HINT =
  "An interactive session can't be stopped here. Type /bg in its terminal to move it to the background, then stop it here.";
export const CWD_MISSING_HINT = 'The working directory no longer exists, for example after a worktree was removed.';
/** The worked-in line's info icon: the rule behind it (W34, spike 004), and where to find the sessions that worked in a repo (W39, W42). */
export const WORKED_IN_NOTE =
  "A repo counts when the session changed it, or when at least 5% of its tool calls touched it, its sub-agents' included. View preferences, in the header, sets which of these repos list the session; to find every session that worked in a repo, type its name in the filter on All sessions.";

/** Where a session started and the repos it worked in, as the repo list labels them. */
export interface SessionPlacement {
  /** Its start group's label, from the snapshot, whatever View preferences says, or a root's path for one started in the root itself. */
  startedIn: string;
  /** The repos it worked in beyond that, newest touch first, each by its label, whether or not it has a group (W39). */
  workedIn: readonly string[];
}

/** The actions menu's width items' tooltips, when they can't do anything. */
export const WIDTH_HINTS = {
  wider: "It's as wide as this window allows.",
  narrower: `It's as narrow as it goes, ${PANEL_MIN} px.`,
  reset: "It's at its usual width.",
} as const;

const noStore = () => () => {};

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
  /** In a root tab that isn't open: hidden, with no id, and Escape isn't its. */
  hidden?: boolean;
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
function Frame({ layout, hidden = false, animate, titleId, onEscape, children }: FrameProps) {
  const [opening, setOpening] = useState(animate && layout === 'overlay');
  const onEscapeRef = useRef(onEscape);
  const hiddenRef = useRef(hidden);
  useEffect(() => {
    onEscapeRef.current = onEscape;
    hiddenRef.current = hidden;
  }, [onEscape, hidden]);

  // Escape, last in the layered order (6.2): whatever nearer handled it called preventDefault.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !hiddenRef.current) onEscapeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <section
      id={hidden ? undefined : SESSION_VIEW_ID}
      hidden={hidden}
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
        <Button variant="ghost" icon="back" className="session-view-back" onClick={onClose} aria-keyshortcuts="Escape">
          Back to sessions
        </Button>
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
  /** Where it started and the repos it worked in: a line of the header, when it worked in any. */
  placement?: SessionPlacement | undefined;
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
  /** Whether a Stop or Remove is running, for j, k, ↑ and ↓, which wait for it rather than move the view away (6.2). */
  onRunningChange?: ((running: boolean) => void) | undefined;
  /**
   * The view's width as the third column, which the divider also changes: the actions menu then has
   * Make view wider, Make view narrower and Reset view width, so it can be resized without a drag.
   */
  panel?: PanelWidthStore | undefined;
  /** In a root tab that isn't open (W38): kept, hidden, so its terminal, draft and sends carry on. */
  hidden?: boolean;
}

type Tab = 'conversation' | 'terminal';

/** A copy from the actions menu that the clipboard refused: the text isn't on screen, so the header shows it. */
type Refused = { label: string; text: string };

export function SessionView({
  session,
  placement,
  listed,
  onClose,
  layout = 'overlay',
  compact = false,
  headingRef,
  onStep,
  animate = true,
  onDraftChange,
  onRunningChange,
  panel,
  hidden = false,
}: SessionViewProps) {
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
  const conversation = useConversation(session.lastActivityAt, loader);
  const actions = useSessionActions(session, onClose);
  const [tab, setTab] = useState<Tab>('conversation');
  const [attachStatus, setAttachStatus] = useState<AttachStatus>();
  // The terminal's restart confirmation, open or busy, for Escape's layering.
  const [restart, setRestart] = useState<RestartPhase>();
  // Whether the message box has a draft: Escape never closes the view then (6.2). As state too, so a
  // draft keeps the footer when the session leaves the list, rather than going with it.
  const draft = useRef(false);
  const [drafting, setDrafting] = useState(false);
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

  /** F6 in the terminal: focus moves to the Terminal tab, and the terminal stays open and attached (6.1 rule 14). */
  const focusTerminalTab = useCallback(() => terminalTab.current?.focus(), []);

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

  // ← and → (and Home and End) move focus between the tabs; Enter or Space opens one, never focus alone (4: Tabs).
  const onTabsKey = (event: KeyboardEvent<HTMLDivElement>) => moveTabFocus(event, [conversationTab.current, terminalTab.current]);

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
  const onRunningRef = useRef(onRunningChange);
  onRunningRef.current = onRunningChange;
  useEffect(() => {
    onRunningRef.current?.(busy);
  }, [busy]);
  useEffect(() => () => onRunningRef.current?.(false), []);
  // What the width items can do, which changes only at the limits, so a drag doesn't re-render the view.
  const limits = useSyncExternalStore(panel?.subscribe ?? noStore, () => (panel ? panelLimits(panel.get()) : ''));
  const [canWiden, canNarrow, canReset] = limits.split('|').map((part) => part !== '');
  const widthEntries: MenuEntry[] = panel
    ? [
        { kind: 'separator', id: 'width-separator' },
        {
          id: 'wider',
          label: 'Make view wider',
          disabled: !canWiden,
          hint: WIDTH_HINTS.wider,
          onSelect: () => panel.set(shownPanel(panel.get()) + PANEL_MENU_STEP, true),
        },
        {
          id: 'narrower',
          label: 'Make view narrower',
          disabled: !canNarrow,
          hint: WIDTH_HINTS.narrower,
          onSelect: () => panel.set(shownPanel(panel.get()) - PANEL_MENU_STEP, true),
        },
        { id: 'reset-width', label: 'Reset view width', disabled: !canReset, hint: WIDTH_HINTS.reset, onSelect: () => panel.set(panelReset(panel.get().appWidth), true) },
      ]
    : [];
  const entries: MenuEntry[] = [
    { id: 'copy-id', label: 'Copy session ID', icon: 'copy', onSelect: () => copy('Session ID', sessionId) },
    ...(command ? [{ id: 'copy-attach', label: 'Copy attach command', icon: 'terminal' as const, onSelect: () => copy('Attach command', command) }] : []),
    ...widthEntries,
    // An interactive session can't be stopped from here, so Stop session is off, saying how /bg changes that.
    ...(!background && listed
      ? [
          { kind: 'separator' as const, id: 'separator' },
          { id: 'stop', label: 'Stop session', icon: 'stop' as const, disabled: true, hint: STOP_INTERACTIVE_HINT, onSelect: () => {} },
        ]
      : []),
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
  const shownEntries = conversation.state.entries;
  // Shown once: the footer leaves out a reply the conversation already has.
  const replyShown = useMemo(() => (session.relay ? replyInConversation(session.relay, shownEntries) : false), [session.relay, shownEntries]);
  const attached = tab === 'terminal' && attachStatus?.kind === 'attached';

  return (
    <Frame layout={layout} hidden={hidden} animate={animate} titleId={ids.title} onEscape={onEscape}>
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
          {/*
            The row's other badges, each with an info button after it, so its explanation, which is a
            hover-only tooltip in the row, is reachable here by keyboard and screen readers.
          */}
          {session.finished && session.askedYou && (
            <span className="session-view-badge">
              <Badge look="outline">Asked you</Badge>
              <InfoTip text={FINISHED_ASKED_HINT} className="session-view-info" />
            </span>
          )}
          {session.stale && (
            <span className="session-view-badge">
              <Badge look="subtle-neutral" className="stale">
                Stale
              </Badge>
              <InfoTip text={STALE_HINT} className="session-view-info" />
            </span>
          )}
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
        {placement && placement.workedIn.length > 0 && (
          // Line 3: where it started, and the repos it worked in beyond that, the same in every mode of View preferences (W42).
          // The names are text, never markup or links: selecting one does nothing.
          <p className="session-view-worked">
            <span className="session-view-worked-text">
              Started in <span className="session-view-repo">{plainText(placement.startedIn)}</span>
              <span aria-hidden="true"> · </span>
              <span className="visually-hidden">, and </span>
              worked in{' '}
              {placement.workedIn.map((label, index) => (
                // By place as well as label: two repos under different roots can share a label.
                <span key={`${index}:${label}`}>
                  {index > 0 && ', '}
                  <span className="session-view-repo">{plainText(label)}</span>
                </span>
              ))}
            </span>
            <InfoTip text={WORKED_IN_NOTE} className="session-view-info" />
          </p>
        )}
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

      {/* Hidden behind the Terminal tab, or with its root tab: either way it goes back to the reader's place when shown. */}
      <ConversationPanel conversation={conversation} id={ids.conversationPanel} labelledBy={ids.conversationTab} hidden={tab !== 'conversation' || hidden} />

      <div
        className="session-view-terminal"
        role="tabpanel"
        id={ids.terminalPanel}
        aria-labelledby={ids.terminalTab}
        hidden={tab !== 'terminal'}
      >
        {tab === 'terminal' && attachEnv && (
          <SessionTerminal
            sessionId={sessionId}
            env={attachEnv}
            onClose={leaveTerminal}
            onLeave={focusTerminalTab}
            onStatus={setAttachStatus}
            onRestartChange={setRestart}
          />
        )}
      </div>

      {session.kind === 'interactive' && (listed || drafting) && (
        <footer className="session-view-foot">
          <RelayBox
            session={session}
            listed={listed}
            replyShown={replyShown}
            onDraftChange={(has) => {
              draft.current = has;
              setDrafting(has);
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
 * was open: there's nothing to show, so the view says so, as an empty state whose title is the view's
 * heading, and offers Close. It never attaches, sends or changes anything.
 */
export function UnlistedSessionView({ sessionId, roots, onClose, layout = 'overlay', compact = false, headingRef, animate = true }: UnlistedSessionViewProps) {
  const titleId = useId();
  const id = plainText(sessionId);
  const shown = id.length > ID_SHOWN ? `${id.slice(0, ID_SHOWN)}…` : id;
  return (
    <Frame layout={layout} animate={animate} titleId={titleId} onEscape={onClose}>
      <header className="session-view-head">
        <Top compact={compact} onClose={onClose}>
          <span className="session-view-spacer" />
        </Top>
      </header>
      <div className="session-view-body session-view-state">
        <EmptyState
          icon="info"
          heading={{ id: titleId, ref: headingRef }}
          title="This session isn't listed under these roots"
          sentence={
            <>
              pitwall lists no session with the id <code>{shown}</code> under {plainText(formatRoots(roots))}; it may have been removed, or
              run outside these roots.
            </>
          }
        />
      </div>
    </Frame>
  );
}

export interface WaitingSessionViewProps {
  /** How long the first snapshot has taken (Waiting.tsx), from the dashboard, so it matches the lists. */
  waiting: Waiting;
  /** What's slow, after --pw-delay-long: the same line as the session list's. */
  slow: ReactNode;
  onClose: () => void;
  layout?: SessionViewLayout;
  compact?: boolean;
  headingRef?: RefObject<HTMLHeadingElement | null>;
  animate?: boolean;
}

/**
 * A URL's ?session= before the first snapshot (3: Session view): the view, with Close, and skeletons
 * for its header after --pw-delay-spinner, then the line saying what's slow after --pw-delay-long. The
 * snapshot replaces it with the session, or with the unlisted state. It takes no focus, and never
 * attaches, sends or changes anything.
 */
export function WaitingSessionView({ waiting, slow, onClose, layout = 'overlay', compact = false, headingRef, animate = true }: WaitingSessionViewProps) {
  const titleId = useId();
  return (
    <Frame layout={layout} animate={animate} titleId={titleId} onEscape={onClose}>
      <header className="session-view-head">
        <Top compact={compact} onClose={onClose}>
          <h2 className="session-view-title" id={titleId} ref={headingRef} tabIndex={-1}>
            <span className="visually-hidden">Session</span>
            {waiting.shown && <SkeletonHeading />}
          </h2>
        </Top>
        {waiting.shown && <SkeletonMeta />}
      </header>
      <div className="session-view-body">
        <WaitingStatus waiting={waiting} label="Loading the session" slow={slow} />
      </div>
    </Frame>
  );
}
