// The session view (docs/design-system.md, 3: Session view, and 4: Session view: header, tabs and
// footer): one session, as the third column from 1,200 px or over the session list below that. A
// header with its name and title, status, kind, last activity and directory, where it started and
// the repos it worked in when there are any (W34), and the actions menu, with Open in VS Code and Open
// in Cursor for the editors pitwall's server found (W72, editors.ts);
// the Conversation and Terminal tabs; the body, which is all that scrolls; and the footer: the message
// box for an interactive session, or for a background one a note that it takes messages in its
// terminal (W47). Under line 2, a line says where to answer while it waits on you, and another what to
// do about a directory that has gone (W47).
//
// An ended interactive session (W67), whose process has exited, has the Conversation tab alone, Ended
// as its status, and in the footer a note with Resume in background and Copy command, which its actions
// menu has too, in place of Stop (EndedSession.tsx). Resumed from here, it's listed again under the
// same id as a running background session, and the view then opens its Terminal tab once, as W54 opens
// a running background session's view, whether the snapshot says so before the server's answer or
// after, with no focus taken (W57): nothing in the page asked for the terminal, and it attaches seconds
// after the press. Focus in the footer as it goes moves to the Terminal tab, or the heading.
//
// Two more states take the view's place: waiting, while a ?session= from the URL waits for the first
// snapshot, and unlisted, for one that pitwall doesn't list under its roots (3: Session view).
//
// With root tabs (W38), each tab keeps its own open session, and the views of the tabs that aren't
// open stay mounted, hidden, so switching tabs never detaches a terminal, drops a draft, or stops a
// send or an action in flight. A hidden view has no id and ignores Escape, and its conversation keeps
// the reader's place, as it does behind the Terminal tab.
//
// The tab it opens on (W54): a running background session's Terminal tab, which attaches, as View
// preferences says unless it says Conversation; Conversation for the rest, finished background
// sessions included, since attaching restarts them, and wherever the Terminal tab is off. It's decided
// as the view is first shown, and never again: the tab you choose is yours, whatever the session does
// after. A view opened by stepping (j, k, ↑, ↓) waits before its terminal attaches (Terminal.tsx).
//
// The terminal takes focus as it attaches only right after you asked for it in this page (W57,
// focusGesture.ts): a click or Enter on the session's row (`openedBy`, from the Dashboard), on the
// Terminal tab, on Attach again or on Restart and attach, and only while focus is still in the view.
// A view opened from the URL, a reload, back or forward, a root tab's switch or a step attaches as
// W54 has it, but leaves focus where it is, and the terminal's bar says how to type to it. A setting
// (terminalFocus.ts) can make it never take focus at all.
//
// The Sub-agents tab (W77, Subagents.tsx) lists the sub-agents the session started, and opens one's
// transcript, read-only. It shows once there's at least one: the view asks for the list once, after
// its conversation's first page, and the snapshot's running count, or an entry in the conversation
// about one, show it too. Once shown, it stays, so the tab row never loses a tab under you. A link on
// such an entry opens that sub-agent's transcript there. The footer goes while the tab is open: there's
// no message box for a sub-agent.
//
// The conversation is its own component (Conversation.tsx, W27), and the terminal's internals are
// W29's. The message box (RelayBox) and the inline confirmations (SessionActions, and the terminal's
// restart) are W24's; the tooltips, toasts and copy buttons are W25's.

import { Fragment, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import type { Editor, EditorId, SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext } from '../api.js';
import { AttachContext, type AttachStatus } from '../attach.js';
import type { BackgroundTab } from '../backgroundTab.js';
import { getConversation } from '../conversation.js';
import { COPIED, COPY_FAILED, selectText, useCopy } from '../copy.js';
import { DraftStorageContext, hasStoredDraft } from '../drafts.js';
import { EditorsContext, openInEditor, openLabel, openToast } from '../editors.js';
import { focusGesture, spendGesture, type FocusGesture } from '../focusGesture.js';
import { DEFAULT_TERMINAL_FOCUS, type TerminalFocus } from '../terminalFocus.js';
import { formatRoots, plainText, shortenHome } from '../format.js';
import { PANEL_MENU_STEP, PANEL_MIN, panelLimits, panelReset, shownPanel, type PanelWidthStore } from '../panelWidth.js';
import { replyInConversation } from '../relay.js';
import { attachCommand, resumeCommand, statusBadge } from '../sessions.js';
import { SHORTCUT_KEYS } from '../shortcuts.js';
import { moveTabFocus } from '../tabs.js';
import { Alert } from './Alert.js';
import { Badge, StatusBadge } from './Badge.js';
import { Button } from './Button.js';
import { ConversationPanel, SubagentLinkContext, useConversation, type PageLoader, type SubagentRef } from './Conversation.js';
import { CopyButton } from './CopyButton.js';
import { COPY_RESUME_COMMAND, EndedFooter, RESUME_LABEL, useResume } from './EndedSession.js';
import { EmptyState } from './EmptyState.js';
import { Icon } from './Icon.js';
import { InfoTip } from './InfoTip.js';
import { MenuButton, type MenuEntry } from './Menu.js';
import { MiddleEllipsis } from './MiddleEllipsis.js';
import { RelayBox } from './RelayBox.js';
import { SessionConfirm, useSessionActions } from './SessionActions.js';
import { finishedAskedHint, SESSION_VIEW_ID, STALE_HINT } from './SessionRow.js';
import { StarButton } from './StarButton.js';
import { SubagentsPanel, subagentsCount, useSubagents } from './Subagents.js';
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
/** The command that ends an interactive session from its own terminal, in code style wherever a note names it. */
export const EXIT_COMMAND = '/exit';
/**
 * The line under line 2 when a session's directory has gone (W47): why it's still listed, and what
 * ends it or takes it off the list, by kind and state. pitwall can't end an interactive session (W40).
 */
export const CWD_MISSING_NOTES = {
  /** Interactive, and running in its terminal. */
  interactive: `It's still running in its terminal, so it's listed. Type ${EXIT_COMMAND} there to end it.`,
  /** Background, and running: Stop session is on. */
  running: "It's still running, so it's listed. Stop session, in the actions menu, ends it.",
  /** Background, and not running, whether it finished or its process exited: Remove session is on. */
  notRunning: "It isn't running. Remove session, in the actions menu, takes it off the list.",
} as const;
/**
 * A background session's footer, where an interactive session has its message box (W47, D2, D3):
 * it takes messages in its terminal. Opening the Terminal tab attaches, so the note has no button
 * that opens it; from the Conversation tab, the tab stays the one deliberate way in (D9). A running
 * one's view opens on its Terminal tab anyway, unless Preferences says Conversation (W54).
 */
export const BACKGROUND_NOTES = {
  running: 'To message it, type in its Terminal tab, which attaches to it.',
  /** Finished, or its process exited: attaching restarts it, and the terminal asks first. */
  notRunning: 'To message it, open its Terminal tab, which asks before restarting it.',
} as const;

/**
 * The note for a session whose directory has gone, or undefined for none: for an interactive session
 * that isn't running, which neither pitwall nor a terminal can act on, and for one that's no longer
 * listed, whose actions menu has no Stop or Remove and whose header's alert says why.
 */
export function cwdMissingNote(session: SessionSummary, listed: boolean): string | undefined {
  if (!session.cwdMissing || !listed) return undefined;
  if (session.kind === 'interactive') return session.alive ? CWD_MISSING_NOTES.interactive : undefined;
  return session.alive ? CWD_MISSING_NOTES.running : CWD_MISSING_NOTES.notRunning;
}

/**
 * The line under line 2 while a running session waits on you (W47): where to answer. The status badge
 * already says it's waiting, and on what, as Claude Code gives it, so this says only where. A question
 * dialog open in its terminal seems not to be in the transcript until it's answered (PLAN.md, seen on
 * one session), so the badge and this may be all pitwall can show of it.
 */
export const WAITING_NOTES = {
  /** pitwall can't answer for it, and a relayed message waits until it's answered. */
  interactive: "Answer it in its terminal: pitwall can't, and a message sent below waits until you do.",
  /** Opening the Terminal tab attaches, so there's no button for it here either (D9). */
  background: 'Answer it in its Terminal tab, which attaches to it.',
} as const;

/**
 * Whether a running session is waiting on you to answer something: it has the solid Waiting or
 * Blocked badge (statusBadge()), which says so from its context (needsYou, W69): a prompt on screen,
 * a background job's own line on what it needs, or blocked where pitwall couldn't read why. A
 * blocked job that needs nothing of you, as a resumed one's "send a prompt to start", has neither.
 */
function isWaiting(session: SessionSummary): boolean {
  if (!session.alive) return false;
  const { status } = statusBadge(session);
  return status === 'waiting' || status === 'blocked';
}

/**
 * The note for a session that's waiting on you, or undefined for none: once it's no longer listed,
 * and, for a background session, where its Terminal tab can't be opened.
 */
export function waitingNote(session: SessionSummary, listed: boolean, canAttach: boolean): string | undefined {
  if (!listed || !isWaiting(session)) return undefined;
  if (session.kind === 'interactive') return WAITING_NOTES.interactive;
  return canAttach ? WAITING_NOTES.background : undefined;
}

/** A note's text, with /exit in code style wherever it names it (5: Casing and style). */
function NoteText({ text }: { text: string }): ReactNode {
  return text.split(EXIT_COMMAND).map((part, index) => (
    <Fragment key={index}>
      {index > 0 && <code>{EXIT_COMMAND}</code>}
      {part}
    </Fragment>
  ));
}

/** The worked-in line's info icon: the rule behind it (W34, spike 004), and where to find the sessions that worked in a repo (W39, W42). */
export const WORKED_IN_NOTE =
  "A repo counts when the session changed it, or when at least 5% of its tool calls touched it, its sub-agents' included. Group sessions by, in Preferences, sets which of these repos list the session; to find every session that worked in a repo, type its name in the filter on All sessions.";

/** Where a session started and the repos it worked in, as the repo list labels them. */
export interface SessionPlacement {
  /** Its start group's label, from the snapshot, whatever Group sessions by says, or a root's path for one started in the root itself. */
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
   * Whether a question is open in the view: a Stop or Remove confirmation, or the terminal's restart
   * prompt, asking or restarting. A session started from New session doesn't replace the view then (W63).
   */
  onPromptChange?: ((open: boolean) => void) | undefined;
  /**
   * The view's width as the third column, which the divider also changes: the actions menu then has
   * Make view wider, Make view narrower and Reset view width, so it can be resized without a drag.
   */
  panel?: PanelWidthStore | undefined;
  /** In a root tab that isn't open (W38): kept, hidden, so its terminal, draft and sends carry on. */
  hidden?: boolean;
  /** Its star toggle, before the actions menu (W53): whether it's starred, and a way to star or unstar it. */
  star?: { starred: boolean; onStar: (sessionId: string, on: boolean) => void } | undefined;
  /**
   * The tab a running background session's view opens on (W54), Preferences' Open running
   * background sessions on, read as the view is first shown. Left out, as the gallery's specimens and
   * the tests of a view alone do, it opens on Conversation. The Dashboard always gives it.
   */
  backgroundTab?: BackgroundTab | undefined;
  /**
   * Opened by stepping onto the session, with j, k, ↑ or ↓ (W54): a terminal it opens on waits
   * --pw-delay-attach before attaching, and takes no focus when it does. Read as the view opens.
   */
  stepped?: boolean;
  /**
   * The click or Enter on the session's row that opened the view (W57): a terminal it opens on may
   * take focus as it attaches, once, soon after (focusGesture.ts). Left out, as for a view opened from
   * the URL, the back button or a step, it takes none until you open the tab or click the terminal.
   */
  openedBy?: FocusGesture | undefined;
  /**
   * When its terminal may take the keyboard (W57, terminalFocus.ts): right after you open the view or
   * its Terminal tab in this page, the default, or never. Read each time the terminal attaches.
   */
  terminalFocus?: TerminalFocus | undefined;
  /**
   * The newest poll's time, a snapshot's or a heartbeat's generatedAt: while its Sub-agents tab is open
   * and any of them run, the tab asks for the list again at this pace (W77). Left out, as in the
   * gallery and the tests of a view alone, it follows the session's activity instead.
   */
  polledAt?: string | undefined;
}

type Tab = 'conversation' | 'terminal' | 'subagents';

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
  onPromptChange,
  panel,
  hidden = false,
  star,
  backgroundTab = 'conversation',
  stepped = false,
  openedBy,
  terminalFocus = DEFAULT_TERMINAL_FOCUS,
  polledAt,
}: SessionViewProps) {
  const api = useContext(ApiContext);
  const attachEnv = useContext(AttachContext);
  const ids = {
    title: useId(),
    conversationTab: useId(),
    conversationPanel: useId(),
    terminalTab: useId(),
    terminalPanel: useId(),
    subagentsTab: useId(),
    subagentsPanel: useId(),
    typeHint: useId(),
  };
  const ownHeading = useRef<HTMLHeadingElement>(null);
  const heading = headingRef ?? ownHeading;
  const menuButton = useRef<HTMLButtonElement>(null);
  const conversationTab = useRef<HTMLButtonElement>(null);
  const terminalTab = useRef<HTMLButtonElement>(null);
  const subagentsTab = useRef<HTMLButtonElement>(null);
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
  const signal = useCallback(() => requests.current?.signal, []);
  const subagents = useSubagents(api, sessionId, signal);
  const actions = useSessionActions(session, onClose);
  // Resumed from this view (W67): it opens its Terminal tab once the snapshot lists it as running.
  const resume = useResume(session);
  const { takePressed } = resume;
  // The ended footer went with focus inside it: focus moves in the view, never to the page.
  const footFocus = useRef(false);
  const onFootFocusLeaving = useCallback(() => {
    footFocus.current = true;
  }, []);

  // An ended interactive session (W67): no process, so no Terminal tab and no message box.
  const ended = session.ended === true;
  // An interactive session, or a background one that can't be attached from here.
  const background = session.kind === 'background';
  const terminalOff = !background
    ? TERMINAL_INTERACTIVE_NOTE
    : !attachEnv
      ? 'Attach is unavailable here.'
      : !listed
        ? "It's no longer listed, so it can't be attached."
        : undefined;

  /**
   * The tab it opens on (W54): Terminal for a running background session it can attach, unless View
   * preferences says Conversation; Conversation for the rest. A finished one restarts when attached,
   * which the restart confirmation asks first, so it waits for you to open the tab.
   */
  const openingTab = (): Tab => (backgroundTab === 'terminal' && background && session.alive && terminalOff === undefined ? 'terminal' : 'conversation');
  // Undefined until the view is first shown: one that opens hidden, in a root tab that isn't open (W38),
  // as a session started there does, decides when that tab is opened, so it never attaches unseen.
  const [chosen, setChosen] = useState<Tab | undefined>(() => (hidden ? undefined : openingTab()));
  const tab = chosen ?? 'conversation';
  useLayoutEffect(() => {
    if (chosen === undefined && !hidden) setChosen(openingTab());
  });
  // Opened by stepping: its first terminal waits, and takes no focus. Opening a tab yourself ends that.
  const [quiet, setQuiet] = useState(stepped);
  const [attachStatus, setAttachStatus] = useState<AttachStatus>();
  // The terminal's restart confirmation, open or busy, for Escape's layering.
  const [restart, setRestart] = useState<RestartPhase>();
  // Whether the message box has a draft: Escape never closes the view then (6.2). As state too, so a
  // draft keeps the footer when the session leaves the list, rather than going with it. A draft the
  // tab kept counts from the start (W44), so the footer is there for it in a view opened again once
  // its session has left the list.
  const draftStorage = useContext(DraftStorageContext);
  const [drafting, setDrafting] = useState(() => session.kind === 'interactive' && hasStoredDraft(session.sessionId, draftStorage));
  const draft = useRef(drafting);
  const copyText = useCopy();
  const toast = useToast();
  const [refused, setRefused] = useState<Refused>();
  // Open in an editor (W72): the editors the server found, and the one being opened in, if any.
  const editors = useContext(EditorsContext);
  const [openingIn, setOpeningIn] = useState<EditorId>();
  const openingRef = useRef(false);

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

  /**
   * Opens the session's directory in `editor`, through pitwall's server (W72). The result is a toast,
   * from the app's stack, so it still arrives when the view has gone meanwhile.
   */
  const openIn = (editor: Editor) => {
    if (!api || openingRef.current) return;
    openingRef.current = true;
    setOpeningIn(editor.id);
    void openInEditor(api, sessionId, editor.id).then((outcome) => {
      openingRef.current = false;
      if (alive.current) setOpeningIn(undefined);
      const shown = openToast(session.name, editor, outcome);
      if (shown) toast(shown);
    });
  };

  // The gesture the next attach may take focus with (W57): the row's click or Enter that opened the
  // view, then the latest on the Terminal tab, Attach again or Restart and attach. Each is spent once.
  const asked = useRef<FocusGesture | undefined>(openedBy);
  useEffect(() => {
    if (openedBy) asked.current = openedBy;
  }, [openedBy]);

  /** Opening Terminal attaches; for a session that isn't running, the terminal first asks to restart it (D9). */
  const openTab = (next: Tab) => {
    if (next === 'terminal' && terminalOff) return;
    setChosen(next);
    // Chosen: a terminal opened from here attaches at once, and may take focus as it does. The tab
    // takes focus itself, as Safari doesn't give it a button that's clicked, so the attach finds
    // focus still in the view.
    if (next !== tab) {
      setQuiet(false);
      asked.current = next === 'terminal' ? focusGesture(terminalTab.current) : undefined;
      if (next === 'terminal') focusQuietly(terminalTab.current);
      // Safari doesn't give a clicked button focus, and the footer, which may have had it, goes with this tab.
      if (next === 'subagents') focusQuietly(subagentsTab.current);
    }
    // Switching to Conversation or Sub-agents unmounts the terminal, which detaches.
    if (next !== 'terminal') setAttachStatus(undefined);
  };

  // The Sub-agents tab (W77): the sub-agent whose transcript is open there, and the one whose row takes
  // focus when Back returns to the list.
  const [openAgent, setOpenAgent] = useState<SubagentRef>();
  const [returnTo, setReturnTo] = useState<string>();
  // Bumped each time one is opened, so its heading takes focus even when it's the one already open there.
  const [opened, setOpened] = useState(0);
  /** A row, or a link on an entry about a sub-agent: its transcript, in the Sub-agents tab, with focus on its heading. */
  const openSubagent = useCallback((subagent: SubagentRef) => {
    setChosen('subagents');
    setQuiet(false);
    setAttachStatus(undefined);
    asked.current = undefined;
    setOpenAgent(subagent);
    setOpened((count) => count + 1);
  }, []);
  /** Back: the list, with focus on that sub-agent's row. */
  const backToSubagents = () => {
    setReturnTo(openAgent?.agentId);
    setOpenAgent(undefined);
  };

  /** Detach, Cancel on the restart, or Back to the conversation: the conversation, with focus on the Terminal tab. */
  const leaveTerminal = useCallback(() => {
    setChosen('conversation');
    setQuiet(false);
    setAttachStatus(undefined);
    asked.current = undefined;
    terminalTab.current?.focus();
  }, []);

  /** Attach again or Restart and attach, in the terminal: asked for here. */
  const askedInTerminal = useCallback((target: Element | undefined) => {
    asked.current = focusGesture(target);
  }, []);

  /**
   * Whether the terminal may take focus as it attaches (W57): only with a gesture from this page, soon
   * before, and while focus is still in this view or on what was pressed, so a key typed elsewhere
   * meanwhile, in the filter say, never goes to the session. Never with focus nowhere, as after a load,
   * and never at all while the setting says so, though the gesture is spent either way.
   */
  const focusRule = useRef(terminalFocus);
  focusRule.current = terminalFocus;
  const terminalMayFocus = useCallback(() => {
    const allowed = spendGesture(asked.current, heading.current?.closest('section'));
    return allowed && focusRule.current !== 'never';
  }, [heading]);

  /** F6 in the terminal: focus moves to the Terminal tab, and the terminal stays open and attached (6.1 rule 14). */
  const focusTerminalTab = useCallback(() => terminalTab.current?.focus(), []);

  // Resumed from here (W67), and now listed as the session it has become: a running background
  // session's view opens on its Terminal tab, as Preferences says (W54), so this one goes there once,
  // as it would have opened. The press counts from when it's made until it fails or is given up on, so
  // this happens whether the snapshot lists it as running before the server answers or after; taking
  // it clears it, so it can't happen again later. Its terminal takes no focus (W57): the press was
  // seconds before the attach, and asked to resume, not to type. In a root tab that isn't open (W38),
  // this waits until that tab is.
  useLayoutEffect(() => {
    if (ended || hidden || !takePressed()) return;
    if (openingTab() === 'terminal') {
      asked.current = undefined;
      setQuiet(false);
      setChosen('terminal');
    }
  }, [ended, hidden]);

  // The ended footer went with focus inside it, Resume in background's say, as the session was listed
  // as running or left the list: focus goes to the Terminal tab, the way in, or the heading where
  // there's none, rather than the page.
  useLayoutEffect(() => {
    if (!footFocus.current) return;
    footFocus.current = false;
    focusQuietly(terminalTab.current ?? heading.current);
  });

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
  const onTabsKey = (event: KeyboardEvent<HTMLDivElement>) => moveTabFocus(event, [conversationTab.current, terminalTab.current, subagentsTab.current]);

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
  const missingNote = cwdMissingNote(session, listed);
  const waiting = waitingNote(session, listed, background && !terminalOff);
  const canAct = background && listed;
  const busy = actions.running !== undefined;
  // j, k, ↑ and ↓ wait for a resume's request too, so its result shows in the view it was asked from.
  const requesting = busy || resume.phase === 'running';
  const resumeCopy = ended ? resumeCommand(session) : undefined;
  const canResume = ended && listed && !session.cwdMissing;
  const onRunningRef = useRef(onRunningChange);
  onRunningRef.current = onRunningChange;
  useEffect(() => {
    onRunningRef.current?.(requesting);
  }, [requesting]);
  useEffect(() => () => onRunningRef.current?.(false), []);
  // A confirmation or the terminal's restart prompt, open, for a started session that would replace the view (W63).
  const prompting = actions.confirming !== undefined || (tab === 'terminal' && restart !== undefined);
  const onPromptRef = useRef(onPromptChange);
  onPromptRef.current = onPromptChange;
  useEffect(() => {
    onPromptRef.current?.(prompting);
  }, [prompting]);
  useEffect(() => () => onPromptRef.current?.(false), []);
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
  // One item per editor the server found (W72), while it's listed and its directory exists: an ended
  // session's too, since its directory may still be there. None found, none shown.
  const editorEntries: MenuEntry[] =
    api && listed && !session.cwdMissing && editors.length > 0
      ? [
          { kind: 'separator', id: 'editors-separator' },
          ...editors.map((editor) => ({
            id: `open-${editor.id}`,
            label: openLabel(editor),
            icon: 'external' as const,
            disabled: openingIn !== undefined,
            hint: 'Wait for the editor to open.',
            onSelect: () => openIn(editor),
          })),
        ]
      : [];
  const entries: MenuEntry[] = [
    { id: 'copy-id', label: 'Copy session ID', icon: 'copy', onSelect: () => copy('Session ID', sessionId) },
    ...(command ? [{ id: 'copy-attach', label: 'Copy attach command', icon: 'terminal' as const, onSelect: () => copy('Attach command', command) }] : []),
    ...(resumeCopy ? [{ id: 'copy-resume', label: COPY_RESUME_COMMAND, icon: 'terminal' as const, onSelect: () => copy('Resume command', resumeCopy) }] : []),
    ...editorEntries,
    ...widthEntries,
    // An ended session can be resumed, never stopped or removed: it has no process (W67).
    ...(canResume
      ? [
          { kind: 'separator' as const, id: 'separator' },
          {
            id: 'resume',
            label: RESUME_LABEL,
            icon: 'restart' as const,
            disabled: resume.phase !== 'idle',
            hint: resume.phase === 'running' ? 'Wait for the current action to finish.' : 'It has resumed. It shows as a background session once pitwall lists it.',
            onSelect: resume.run,
          },
        ]
      : []),
    // An interactive session can't be stopped from here, so Stop session is off, saying how /bg changes that.
    ...(!background && !ended && listed
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

  // The Sub-agents tab shows once the session is known to have any (W77): the list says so, the
  // snapshot counts some running, or an entry in the conversation is about one. Then it stays.
  const subagentsOpen = tab === 'subagents' && !hidden;
  const running = session.subagentsRunning ?? 0;
  const mentioned = useMemo(() => shownEntries.flatMap((entry) => (entry.subagent ? [entry.subagent.agentId] : [])), [shownEntries]);
  const listedIds = subagents.state.list?.subagents;
  const [revealed, setRevealed] = useState(false);
  const hasSubagents = (listedIds !== undefined && listedIds.length > 0) || running > 0 || mentioned.length > 0;
  if (hasSubagents && !revealed) setRevealed(true);
  const subagentsShown = revealed || hasSubagents;
  // Sub-agents an entry names that the list doesn't have yet, as for one that started since: asked for again, once each.
  const unlisted = useMemo(() => {
    if (!listedIds || subagents.state.list?.truncated) return '';
    const known = new Set(listedIds.map((each) => each.agentId));
    return [...new Set(mentioned.filter((agentId) => !known.has(agentId)))].sort().join(' ');
  }, [listedIds, mentioned, subagents.state.list?.truncated]);
  // While the tab is open and any run, at the index's pace; or else the session's activity's.
  const pace = subagentsOpen && running > 0 ? (polledAt ?? session.lastActivityAt ?? '') : '';
  const { ensure: ensureSubagents, refresh: refreshSubagents } = subagents;
  // Again when the tab opens, at that pace while it's open, when the running count changes, and for a
  // sub-agent the conversation names that the list hasn't got: never the first time, which is below.
  useEffect(() => {
    if (listed) refreshSubagents();
  }, [subagentsOpen, pace, running, unlisted, listed, refreshSubagents]);
  // Once when the view opens, after its conversation's first page, so the two never wait on each other
  // for the server's four reads at once, and a view only passed through with j or k asks nothing more.
  // Or first when the tab is opened, as from a link.
  const firstPage = conversation.state.status !== 'loading';
  useEffect(() => {
    if (firstPage || subagentsOpen) ensureSubagents();
  }, [firstPage, subagentsOpen, ensureSubagents]);
  const subagentCount = subagentsCount(subagents.state);

  return (
    <Frame layout={layout} hidden={hidden} animate={animate} titleId={ids.title} onEscape={onEscape}>
      <header className="session-view-head" onKeyDown={onHeaderKey}>
        <Top
          compact={compact}
          onClose={onClose}
          end={
            <>
              {star && <StarButton sessionId={sessionId} name={session.name} starred={star.starred} onStar={star.onStar} size="md" shortcut={SHORTCUT_KEYS.star} />}
              <MenuButton label="Session actions" icon="more" entries={entries} buttonRef={menuButton} />
            </>
          }
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
              <InfoTip text={finishedAskedHint(session)} className="session-view-info" />
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
            {/* A button, so Tab reaches it: its name is the note, which is also its tooltip. Not once it has ended: there's no terminal to type /bg in. */}
            {!background && !ended && <InfoTip text={BG_NOTE} className="session-view-info" />}
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
        {waiting && (
          // Where to answer, under the status badge that says it's waiting (W47). Read once, in place.
          <p className="session-view-waiting-note">{waiting}</p>
        )}
        {missingNote && (
          // Visible, not in a tooltip: why it's still listed, and what to do about it (W47). Read once, in place.
          <p className="session-view-cwd-note">
            <NoteText text={missingNote} />
          </p>
        )}
        {placement && placement.workedIn.length > 0 && (
          // Line 3: where it started, and the repos it worked in beyond that, the same in every mode of Group sessions by (W42).
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
        {/* Disabled, it says why in a tooltip, which describes it. An ended session has none: there's no process to attach to (W67). */}
        {!ended && (
          <Tooltip content={terminalOff} relation="description">
            <button
              ref={terminalTab}
              type="button"
              role="tab"
              id={ids.terminalTab}
              className="session-tab"
              aria-selected={tab === 'terminal'}
              aria-controls={ids.terminalPanel}
              // Attached, it's described by the terminal's hint on how to type to it, which shows while the
              // terminal doesn't have focus, as on this tab after F6 (W57).
              aria-describedby={attached ? ids.typeHint : undefined}
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
        )}
        {/* Once the session is known to have sub-agents, for every kind of session, finished and ended ones included (W77). */}
        {subagentsShown && (
          <button
            ref={subagentsTab}
            type="button"
            role="tab"
            id={ids.subagentsTab}
            className="session-tab"
            aria-selected={tab === 'subagents'}
            aria-controls={ids.subagentsPanel}
            tabIndex={tab === 'subagents' ? 0 : -1}
            onClick={() => openTab('subagents')}
          >
            <Icon name="subagents" />
            Sub-agents
            {subagentCount !== undefined && <span className="session-tab-count"> ({subagentCount})</span>}
          </button>
        )}
      </div>

      <SubagentLinkContext.Provider value={subagentsShown ? openSubagent : undefined}>
        {/* Hidden behind the Terminal tab, or with its root tab: either way it goes back to the reader's place when shown. */}
        <ConversationPanel conversation={conversation} id={ids.conversationPanel} labelledBy={ids.conversationTab} hidden={tab !== 'conversation' || hidden} />
        {subagentsShown && (
          <SubagentsPanel
            api={api}
            sessionId={sessionId}
            controller={subagents}
            id={ids.subagentsPanel}
            labelledBy={ids.subagentsTab}
            hidden={tab !== 'subagents' || hidden}
            open={openAgent}
            opened={opened}
            onOpen={openSubagent}
            onBack={backToSubagents}
            returnTo={returnTo}
            signal={signal}
          />
        )}
      </SubagentLinkContext.Provider>

      {!ended && (
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
              wait={quiet}
              canFocus={terminalMayFocus}
              onAsk={askedInTerminal}
              typeHintId={ids.typeHint}
            />
          )}
        </div>
      )}

      {session.kind === 'interactive' && (listed || drafting) && (
        // Kept while the Sub-agents tab is open, but hidden, so a draft or a send in flight carries on:
        // there's no message box for a sub-agent, and this one's for the session.
        <footer className="session-view-foot" hidden={tab === 'subagents'}>
          {/* An ended session has no message box, except to keep a draft, which is never lost to the session going (W31). */}
          {(!ended || drafting) && (
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
          )}
          {ended && listed && (
            <EndedFooter session={session} resume={resume} onCopy={resumeCopy ? () => copy('Resume command', resumeCopy) : undefined} onFocusLeaving={onFootFocusLeaving} />
          )}
        </footer>
      )}
      {background && !terminalOff && tab === 'conversation' && (
        // Where an interactive session has its message box: how to message this one (W47). No button
        // opens the Terminal tab from here, since opening it attaches (D9). Not on the Terminal tab,
        // which it's about, and which then has the room; not once it's no longer listed, or where it
        // can't be attached, as the tab's tooltip says.
        <footer className="session-view-foot">
          <p className="session-view-note">{session.alive ? BACKGROUND_NOTES.running : BACKGROUND_NOTES.notRunning}</p>
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
