// The app (docs/design-system.md, 3): the header, then three columns, the repo list, the session list
// and the session view. The page doesn't scroll; each column does. Below 1,200 px the session view
// overlays the session list, below the header, and what it covers is inert while it's open; below
// 900 px the repo list is a drawer opened from the header.
//
// The session view is always rendered in the same place, the third column's pane, whatever the
// layout: CSS takes it out of the grid and over the list below 1,200 px. So crossing 1,200 px with a
// session open changes how it sits, not the view itself, which keeps its conversation and terminal.
// The open session is in the URL, as ?session= (openSession.ts).
//
// Before the first snapshot, the repo list and the session list show skeletons, and a ?session= from
// the URL opens the session view in its waiting state, all after --pw-delay-spinner, with a line
// saying what's slow after --pw-delay-long (Waiting.tsx). Once there's a snapshot, an empty selection
// shows its empty state in place of the rows (4: Empty states).
//
// The app strip goes above the header while the relay is off until restart, and the page alerts sit at
// the top of the session list (3: App strip and page alerts). The toasts' stack is inside the app, from
// the first render, so its live region is there before any toast (4: Toasts). Relative times tick on
// the shared clock (clock.ts), each on its own, so the dashboard doesn't re-render every second.
//
// The single-key shortcuts (6.2) are handled here: `/` focuses the filter field, `n` opens the New
// session dialog, `?` the keyboard shortcuts dialog, and `j` and `k` move through the session list as
// shown. shortcuts.ts says which key is which, and when a key isn't one, such as while typing; here,
// they act only on this dashboard's keys, never over a dialog or the repo drawer, and only while
// they're on. One that moves focus closes an open menu first.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import type { SessionSummary } from '../../../src/shared/protocol.js';
import type { ConnectionView } from '../connection.js';
import { formatRoots, plainText } from '../format.js';
import { browserStorage, FINISHED_STATE_KEY, readGroupState, writeGroupState, type GroupState, type StorageSource } from '../groupState.js';
import { useLayout } from '../layout.js';
import { useOpenSession } from '../openSession.js';
import { relayAlertText } from '../relay.js';
import {
  ALL_SESSIONS,
  browserNavigation,
  findGroup,
  finishedStateId,
  scopeFor,
  selectionHref,
  selectionName,
  useSelection,
  type NavigationEnv,
  type Selection,
} from '../selection.js';
import { countAttention, filterListed, filterNeedle, groupId, listScope, NO_FILTERS, noMatchText, type Filters } from '../sessions.js';
import { useSort } from '../sort.js';
import { shortcutFor, useShortcutsStore, type Shortcut } from '../shortcuts.js';
import { useOpenWhenListed } from '../spawn.js';
import { Alert, Detail } from './Alert.js';
import { AppStrip } from './AppStrip.js';
import { Button } from './Button.js';
import { Divider } from './Divider.js';
import { EmptyState } from './EmptyState.js';
import { FilterControls } from './Filters.js';
import { Header } from './Header.js';
import { HighlightContext } from './Highlight.js';
import { closeMenus } from './Menu.js';
import { NewSessionDialog } from './NewSessionDialog.js';
import { RepoDrawer } from './RepoDrawer.js';
import { RepoList } from './RepoList.js';
import { SessionList, type SessionListHeading } from './SessionList.js';
import { SessionView, UnlistedSessionView, WaitingSessionView } from './SessionView.js';
import { ShortcutsDialog } from './ShortcutsDialog.js';
import { SortSelect } from './SortSelect.js';
import { ToastContext, ToastRegion, useToastStack } from './Toast.js';
import { focusQuietly } from './Tooltip.js';
import { SkeletonRows, useWaiting, WaitingStatus } from './Waiting.js';

/**
 * How many dashboards are on the page: one in the app, and several in the #uikit gallery. A shortcut
 * pressed with nothing focused belongs to a dashboard only when it's the only one.
 */
let dashboards = 0;

/** The toast once the server has started a session (5: Success). */
export const startedText = (name: string) => `Started ${plainText(name)}. Its view opens when it shows up in the list.`;

/**
 * What's slow when the first snapshot takes long (4: Skeletons and spinners): the index's first poll,
 * which runs `claude agents`, or, once the connection has dropped, reaching pitwall at all.
 */
export function slowFirstSnapshot(state: ConnectionView['state']): ReactNode {
  return state === 'reconnecting' ? (
    'Still trying to reach pitwall…'
  ) : (
    <>
      Still waiting for <code>claude agents</code>…
    </>
  );
}

/**
 * Whether each page alert arrived after the first snapshot, given its key (what it says, or its time
 * and count), so the caller can give it role="alert". One that was there when the page loaded has no
 * role, so it isn't announced over everything else (4: Alerts and banners). Once its key changes or
 * it goes, it's no longer the one from the page's load.
 */
function useArrivedLive(keys: Record<string, string | undefined>, loaded: boolean): (name: string) => boolean {
  const initial = useRef<Map<string, string> | undefined>(undefined);
  if (loaded && initial.current === undefined) {
    initial.current = new Map(Object.entries(keys).filter((entry): entry is [string, string] => entry[1] !== undefined));
  }
  for (const [name, key] of initial.current ?? []) if (keys[name] !== key) initial.current?.delete(name);
  return (name) => !(initial.current?.has(name) ?? false);
}

export interface DashboardProps {
  view: ConnectionView;
  /** Where the selection and the Finished sections are remembered. Tests pass their own; localStorage otherwise. */
  storage?: StorageSource;
  /** The address bar and history, for the selection. Tests and the gallery pass their own; the window's otherwise. */
  navigation?: NavigationEnv;
}

export function Dashboard({ view, storage = browserStorage, navigation = browserNavigation }: DashboardProps) {
  const { state, snapshot, serverError } = view;
  // A heartbeat brings a newer poll than the snapshot, with nothing else changed.
  const updatedAt = view.lastPoll?.generatedAt ?? snapshot?.generatedAt;
  const source = view.lastPoll?.source ?? snapshot?.source;
  const toasts = useToastStack();
  const app = useRef<HTMLDivElement>(null);
  const { layout, compact, overlayCoversRepos } = useLayout(app);
  const [selection, choose] = useSelection(snapshot, { navigation, storage });
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  // Urgency, Recent or Name, for every selection.
  const [sort, setSort] = useSort(storage);
  // Each selection's Finished section starts collapsed, and is remembered.
  const [finishedOpen, setFinishedOpen] = useState<GroupState>(() => readGroupState(storage, FINISHED_STATE_KEY));
  const [dismissedError, setDismissedError] = useState<string>();
  // The relay alert dismissed, by its time and count: a later one shows again.
  const [dismissedAlert, setDismissedAlert] = useState<string>();
  // The open session, from ?session=. While it's listed, the live summary is shown.
  const opened = useOpenSession(navigation);
  const openId = opened.id;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const reposButton = useRef<HTMLButtonElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const filterField = useRef<HTMLInputElement>(null);
  const shortcuts = useShortcutsStore();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Whether the open session's message box has a draft: no shortcut replaces or closes the view then,
  // just as Escape doesn't (6.2).
  const draft = useRef(false);
  // Whether the open session's Stop or Remove is running: j, k, ↑ and ↓ wait for it, so its result isn't moved away from (6.2).
  const actionRunning = useRef(false);
  /** Whether changing the open session now would lose something: a draft, or a running action's place. */
  const holding = () => draft.current || actionRunning.current;

  // Before the first snapshot: the skeletons after --pw-delay-spinner, and what's slow after --pw-delay-long.
  const waiting = useWaiting(app, snapshot === undefined);
  const slow = slowFirstSnapshot(state);

  const groups = snapshot?.groups ?? [];
  const roots = snapshot?.roots ?? [];
  const allSessions = useMemo(() => groups.flatMap((group) => group.sessions), [groups]);
  const attention = countAttention(allSessions);
  const selectedGroup = findGroup(groups, selection);
  const scope = scopeFor(groups, selection);
  const listed = useMemo(() => (scope ? listScope(groups, scope, sort) : { current: [], finished: [] }), [groups, scope?.kind, selectedGroup, sort]);
  const current = useMemo(() => filterListed(listed.current, filters), [listed, filters]);
  const finished = useMemo(() => filterListed(listed.finished, filters), [listed, filters]);
  // What pitwall last knew of each session, for one that leaves the snapshot while it's open, or that
  // the back button returns to: the view keeps showing it, and says it's no longer listed.
  const known = useRef(new Map<string, SessionSummary>());
  useEffect(() => {
    for (const session of allSessions) known.current.set(session.sessionId, session);
  }, [allSessions]);
  const listedOpen = openId === undefined ? undefined : allSessions.find((session) => session.sessionId === openId);
  const shownOpen = listedOpen ?? (openId === undefined ? undefined : known.current.get(openId));
  // Below 1,200 px the open session's view covers the session list, and below 1,000 px part of the
  // repo list beside it too (3: Session view). What it covers is inert while it's open, so nothing
  // hidden takes focus or a click. The header stays usable above it, and j and k still change the session.
  const overlaid = layout !== 'three-columns' && openId !== undefined;
  const reposCovered = overlaid && overlayCoversRepos;
  // The New session dialog, and the session it started, opened once it's listed.
  const [newSession, setNewSession] = useState(false);
  // Its view takes no focus, unless focus has nowhere to be: started from the no-sessions empty state,
  // whose New session button goes as the session is listed, focus would otherwise be left on the page.
  const openStarted = useCallback(
    (session: SessionSummary) => {
      const active = document.activeElement;
      if (active === null || active === document.body) focusView.current = { id: session.sessionId, on: 'heading' };
      opened.open(session.sessionId);
    },
    [opened.open],
  );
  const started = useOpenWhenListed(allSessions, openStarted);

  // The view's heading, which takes focus when a session is opened from a row or the view's header;
  // or its conversation, when `j` or `k` was pressed there, so ↑ and ↓ go on scrolling it.
  const viewHeading = useRef<HTMLHeadingElement>(null);
  const focusView = useRef<{ id: string; on: 'heading' | 'conversation' } | undefined>(undefined);
  useEffect(() => {
    const target = focusView.current;
    if (target === undefined || target.id !== openId) return;
    focusView.current = undefined;
    const conversation = target.on === 'conversation' ? app.current?.querySelector<HTMLElement>('.session-view-body[role="tabpanel"]') : undefined;
    (conversation ?? viewHeading.current)?.focus();
  });

  // Focus in what the view has just covered, as when the back button opens it or the window narrows
  // past 1,200 px, would be lost as that goes inert: it moves to the view's heading instead. Before
  // the browser's own fix-up, which would put it on the page.
  useLayoutEffect(() => {
    if (!overlaid) return;
    const active = document.activeElement;
    const covered = active instanceof Element && (active.closest('.session-list') !== null || (reposCovered && active.closest('.columns > .repo-list') !== null));
    if (covered && app.current?.contains(active)) viewHeading.current?.focus();
  }, [overlaid, reposCovered]);

  /**
   * The session list's heading, where focus goes when what had it goes away (a dismissed toast, the
   * drawer closing), or the view's heading while the view covers the list.
   */
  const focusList = () => (overlaid ? viewHeading.current : listHeading.current)?.focus();

  /** The session list's row buttons, in the order shown, without those in a collapsed Finished section. */
  const rowButtons = useCallback(
    () => [...(app.current?.querySelectorAll<HTMLElement>('.session-list [data-open-session]') ?? [])].filter((button) => !button.closest('[hidden]')),
    [],
  );
  const rowButton = (sessionId: string) => rowButtons().find((button) => button.dataset.openSession === sessionId);
  /** The row `by` rows from `sessionId`'s in the list as shown, stopping at either end. */
  const rowFrom = (sessionId: string, by: 1 | -1) => {
    const buttons = rowButtons();
    const at = buttons.findIndex((button) => button.dataset.openSession === sessionId);
    return at < 0 ? undefined : buttons[at + by];
  };

  // From a row, by a click or Enter: the view's heading takes focus (6.1, item 8).
  const openSession = useCallback(
    (sessionId: string) => {
      if (sessionId === openId) {
        viewHeading.current?.focus();
        return;
      }
      focusView.current = { id: sessionId, on: 'heading' };
      opened.open(sessionId, 'push');
    },
    [openId, opened.open],
  );

  // ↑ and ↓ on a row: focus moves to the next or previous row, and stays in the list. With the view
  // open, it shows that session too, replacing the history entry. Nothing while the message box has a
  // draft, which changing session would lose, or while a Stop or Remove runs, as `j` and `k` do (6.2).
  const stepFromRow = (sessionId: string, by: 1 | -1) => {
    if (openId !== undefined && holding()) return;
    const next = rowFrom(sessionId, by);
    const id = next?.dataset.openSession;
    if (!next || id === undefined) return;
    next.focus();
    if (openId !== undefined) opened.open(id, 'replace');
  };

  // ↑ and ↓ in the view's header: the next or previous session, with focus on its heading. Nothing
  // while the message box has a draft or a Stop or Remove runs, as on a row.
  const stepFromView = (by: 1 | -1) => {
    if (openId === undefined || holding()) return;
    const next = rowFrom(openId, by);
    const id = next?.dataset.openSession;
    if (!next || id === undefined) return;
    next.scrollIntoView?.({ block: 'nearest' });
    focusView.current = { id, on: 'heading' };
    opened.open(id, 'replace');
  };

  // `j` and `k`: the next or previous session in the list as shown, from the focused row, or else the
  // open session, or else the first row. With the view closed, focus moves to that row. With it open,
  // the view shows that session too: focus stays in the list if it was there, stays in the
  // conversation if it was there, and otherwise goes to the view's heading, as ↑ and ↓ in its header do.
  const stepByKey = (root: HTMLElement, by: 1 | -1): boolean => {
    const buttons = rowButtons();
    const active = document.activeElement;
    const onRow = active instanceof HTMLElement && buttons.includes(active) ? active.dataset.openSession : undefined;
    const from = onRow ?? openId;
    const at = from === undefined ? -1 : buttons.findIndex((button) => button.dataset.openSession === from);
    // A session open that the list doesn't show, filtered out or in a collapsed Finished section, has no next.
    if (from !== undefined && at < 0) return false;
    const next = from === undefined ? buttons[0] : buttons[at + by];
    const id = next?.dataset.openSession;
    if (!next || id === undefined) return false;
    if (openId === undefined) {
      closeMenus(root);
      next.focus();
      return true;
    }
    if (holding()) return false;
    const inList = active instanceof Element && active.closest('.session-list') !== null;
    const inConversation = active instanceof Element && active.closest('.session-view-body') !== null;
    closeMenus(root);
    if (inList) {
      next.focus();
    } else {
      next.scrollIntoView?.({ block: 'nearest' });
      focusView.current = { id, on: inConversation ? 'conversation' : 'heading' };
    }
    opened.open(id, 'replace');
    return true;
  };

  // Closing with Close, Back or Escape gives focus back to the session's row (6.1, item 8).
  const returnFocus = useRef<string | undefined>(undefined);
  const closeSession = useCallback(() => {
    returnFocus.current = openId;
    opened.close();
  }, [openId, opened.close]);

  const previousOpen = useRef(openId);
  useEffect(() => {
    const was = previousOpen.current;
    previousOpen.current = openId;
    if (was === undefined || openId !== undefined) return;
    const asked = returnFocus.current === was;
    returnFocus.current = undefined;
    // The back button closed it: focus goes to the row only if it was inside the view, and so is lost now.
    const active = document.activeElement;
    if (!asked && active !== null && active !== document.body) return;
    const restore = () => (rowButton(was) ?? listHeading.current)?.focus();
    if (layout === 'three-columns') {
      restore();
      return;
    }
    // Over the list, wait a frame, so the row is there to take it.
    const frame = requestAnimationFrame(restore);
    return () => cancelAnimationFrame(frame);
  }, [openId, layout]);

  useEffect(() => {
    document.title = attention > 0 ? `(${attention}) pitwall` : 'pitwall';
    return () => {
      document.title = 'pitwall';
    };
  }, [attention]);

  // The drawer only exists below the sidebar breakpoint: widening the window closes it.
  useEffect(() => {
    if (layout !== 'drawer') setDrawerOpen(false);
  }, [layout]);

  const closeDrawer = () => {
    setDrawerOpen(false);
    focusQuietly(reposButton.current);
  };

  // Choosing in the drawer closes it, and focus goes to the session list's heading (6.1), once the drawer has gone.
  const focusHeading = useRef(false);
  useEffect(() => {
    if (drawerOpen || !focusHeading.current) return;
    focusHeading.current = false;
    focusList();
  }, [drawerOpen]);

  // `/`: the filter field. Below 1,200 px the view covers the list and its filter, so it closes first,
  // as Close would, unless the message box has a draft; focus goes to the field, not the row. The
  // close is applied at once, so the list is no longer inert when the field takes focus.
  const focusFilter = (root: HTMLElement): boolean => {
    const field = filterField.current;
    if (!field) return false;
    if (overlaid && draft.current) return false;
    closeMenus(root);
    if (overlaid) flushSync(() => opened.close());
    field.focus();
    try {
      field.setSelectionRange(field.value.length, field.value.length);
    } catch {
      // A field that can't place the caret keeps it where the browser put it.
    }
    return true;
  };

  const openNewSession = (root: HTMLElement): boolean => {
    if (!snapshot) return false;
    closeMenus(root);
    setNewSession(true);
    return true;
  };

  const openShortcuts = (root: HTMLElement): boolean => {
    closeMenus(root);
    setShortcutsOpen(true);
    return true;
  };

  // The latest of each, for the one key listener. Each says whether it did anything.
  const actions = useRef<Record<Shortcut, (root: HTMLElement) => boolean> | undefined>(undefined);
  actions.current = {
    filter: focusFilter,
    'new-session': openNewSession,
    shortcuts: openShortcuts,
    next: (root) => stepByKey(root, 1),
    previous: (root) => stepByKey(root, -1),
  };

  // On the document, after every handler inside the app, so a key one of them handled isn't a shortcut.
  useEffect(() => {
    dashboards += 1;
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcut = shortcutFor(event);
      const root = app.current;
      if (shortcut === undefined || !root || !shortcuts.get()) return;
      // A key inside this dashboard, or one with nothing focused when it's the only dashboard on the page.
      const target = event.target;
      const nowhere = target === document.body || target === document.documentElement;
      if (!(target instanceof Node && root.contains(target)) && !(nowhere && dashboards === 1)) return;
      // Nothing while a dialog or the repo drawer is open: both are modal.
      if (root.querySelector('[aria-modal="true"]')) return;
      // Handled, so `/` isn't typed into the field it focuses, and the browser's own `/` (Firefox's quick find) doesn't run.
      if (actions.current?.[shortcut](root)) event.preventDefault();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      dashboards -= 1;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [shortcuts]);

  const select = (next: Selection, from: 'list' | 'drawer' | 'elsewhere' = 'elsewhere') => {
    choose(next);
    if (from === 'drawer') {
      focusHeading.current = true;
      setDrawerOpen(false);
    }
  };

  const finishedId = finishedStateId(selection, selectedGroup);
  const toggleFinished = () => {
    if (finishedId === undefined) return;
    const next = new Map(finishedOpen);
    next.set(finishedId, !(finishedOpen.get(finishedId) ?? false));
    setFinishedOpen(next);
    writeGroupState(next, new Set([...groups.map(groupId), 'view:all']), storage, FINISHED_STATE_KEY);
  };

  const showError = serverError !== undefined && serverError !== dismissedError;
  const relayAlert = snapshot?.relayAlert;
  const relayOff = snapshot?.relayOff;
  const relayAlertKey = relayAlert ? `${relayAlert.at}#${relayAlert.count}` : undefined;
  const alertText = relayAlert && relayAlertKey !== dismissedAlert ? relayAlertText(relayAlert, relayOff) : undefined;
  const pollFailed = snapshot && source && !source.ok ? source.error : undefined;
  const live = useArrivedLive(
    { poll: pollFailed, relay: alertText ? relayAlertKey : undefined, error: showError ? serverError : undefined },
    snapshot !== undefined,
  );
  // A warning or danger alert that arrives live is announced; one that was there on load isn't.
  const role = (name: string) => (live(name) ? 'alert' : undefined);
  // Details in the app strip reopens the relay alert and takes focus to it, once it's rendered and
  // nothing covers it. Each press counts, so one with the alert already showing focuses it too.
  const relayAlertRef = useRef<HTMLDivElement>(null);
  const [relayAlertAsked, setRelayAlertAsked] = useState(0);
  useEffect(() => {
    if (relayAlertAsked === 0 || !relayAlertRef.current) return;
    relayAlertRef.current.scrollIntoView?.({ block: 'nearest' });
    relayAlertRef.current.focus();
  }, [relayAlertAsked]);
  // Below 1,200 px the view covers the list, where the alert is: it closes first, as `/` does, unless
  // the message box has a draft, which closing would lose. Then Details does nothing.
  const showRelayAlert = () => {
    if (overlaid && draft.current) return;
    if (overlaid) opened.close();
    setDismissedAlert(undefined);
    setRelayAlertAsked((count) => count + 1);
  };
  // Dismiss goes with its alert, so focus goes to the session list's heading rather than the page.
  const dismiss = (apply: () => void) => () => {
    apply();
    listHeading.current?.focus();
  };
  const alerts = (
    <>
      {pollFailed !== undefined && (
        <Alert tone="warning" role={role('poll')} title="Couldn't list sessions">
          <code>claude agents --json --all</code> failed on the latest poll: <Detail>{plainText(pollFailed)}</Detail>
        </Alert>
      )}
      {relayAlert && alertText && (
        <Alert
          ref={relayAlertRef}
          tone={relayAlert.blocked ? 'warning' : 'danger'}
          role={role('relay')}
          title={alertText.title}
          className="relay-alert"
          onDismiss={dismiss(() => setDismissedAlert(relayAlertKey))}
        >
          {alertText.summary} {alertText.count} Latest: <Detail>{plainText(relayAlert.detail)}</Detail>
        </Alert>
      )}
      {showError && (
        <Alert tone="danger" role={role('error')} onDismiss={dismiss(() => setDismissedError(serverError))}>
          {plainText(serverError)}
        </Alert>
      )}
      {snapshot && state === 'reconnecting' && (
        <Alert tone="neutral" role="status">
          Lost the connection to pitwall. Reconnecting; this list may be out of date.
        </Alert>
      )}
    </>
  );
  const hasAlerts = pollFailed !== undefined || (relayAlert && alertText) || showError || (snapshot && state === 'reconnecting');

  const name = selectionName(groups, selection);
  const heading: SessionListHeading =
    'view' in selection
      ? { label: name }
      : { label: name, kind: selectedGroup?.kind, root: roots.length > 1 ? (selectedGroup?.root ?? selection.root) : undefined };
  const total = listed.current.length + listed.finished.length;
  const shown = current.length + finished.length;
  // The empty states' actions take their button away, so focus goes where the reader carries on: the
  // filter field after a filter action, the session list's heading otherwise.
  const focusField = () => filterField.current?.focus();
  const showAll = (
    <Button
      onClick={() => {
        select(ALL_SESSIONS);
        listHeading.current?.focus();
      }}
    >
      Show all sessions
    </Button>
  );

  // What takes the rows' place, if anything (4: Empty states).
  let empty: ReactNode;
  if (!snapshot) {
    empty = (
      <div className="list-waiting">
        {waiting.shown && <SkeletonRows />}
        <WaitingStatus waiting={waiting} label="Loading sessions" slow={slow} />
      </div>
    );
  } else if (allSessions.length === 0) {
    empty = (
      <EmptyState
        icon="terminal"
        title={`No Claude Code sessions under ${plainText(formatRoots(snapshot.roots))}`}
        sentence="Start one here, or start Claude Code in any terminal under these directories and it appears here."
        actions={
          <Button variant="primary" icon="add" aria-haspopup="dialog" onClick={() => setNewSession(true)}>
            New session
          </Button>
        }
      />
    );
  } else if (!scope) {
    empty = (
      <EmptyState
        icon="directory"
        title={`No sessions in ${plainText(name)} now`}
        sentence="Its sessions are no longer listed under these roots."
        actions={showAll}
      />
    );
  } else if (scope.kind === 'needs-you' && total === 0) {
    empty = (
      <EmptyState
        icon="success"
        title="Nothing needs you right now"
        sentence="Sessions that are waiting for you, or asked you something, show here."
        actions={showAll}
      />
    );
  } else if (shown === 0 && total > 0) {
    const { title, sentence } = noMatchText(filters, plainText(name));
    empty = (
      <EmptyState
        icon="search"
        title={title}
        sentence={sentence}
        actions={
          <>
            <Button
              onClick={() => {
                setFilters(NO_FILTERS);
                focusField();
              }}
            >
              Clear filters
            </Button>
            {scope.kind === 'group' && filters.text.trim() !== '' && (
              // Keeps the text: the same search, across every group.
              <Button
                onClick={() => {
                  select(ALL_SESSIONS);
                  focusField();
                }}
              >
                Search all sessions
              </Button>
            )}
          </>
        }
      />
    );
  }

  const repoList = (from: 'list' | 'drawer') => (
    <RepoList
      groups={snapshot?.groups}
      roots={roots}
      selection={selection}
      onSelect={(next) => select(next, from)}
      autoFocus={from === 'drawer'}
      skeletons={waiting.shown}
      inert={from === 'list' && reposCovered}
    />
  );

  // The open session's view, the same element in every layout so it's never remounted. It slides in
  // only when it opens, not when it goes from one session to the next.
  const viewLayout = layout === 'three-columns' ? 'column' : 'overlay';
  const animate = previousOpen.current === undefined;
  let sessionView: ReactNode;
  if (shownOpen) {
    sessionView = (
      <SessionView
        key={shownOpen.sessionId}
        session={shownOpen}
        listed={listedOpen !== undefined}
        onClose={closeSession}
        layout={viewLayout}
        compact={compact}
        headingRef={viewHeading}
        onStep={stepFromView}
        animate={animate}
        onDraftChange={(has) => {
          draft.current = has;
        }}
        onRunningChange={(running) => {
          actionRunning.current = running;
        }}
      />
    );
  } else if (openId !== undefined && !snapshot) {
    // A ?session= from the URL, before the first snapshot says what it is.
    sessionView = (
      <WaitingSessionView
        key={`waiting:${openId}`}
        waiting={waiting}
        slow={slow}
        onClose={closeSession}
        layout={viewLayout}
        compact={compact}
        headingRef={viewHeading}
        animate={animate}
      />
    );
  } else if (openId !== undefined) {
    sessionView = (
      <UnlistedSessionView
        key={`unlisted:${openId}`}
        sessionId={openId}
        roots={roots}
        onClose={closeSession}
        layout={viewLayout}
        compact={compact}
        headingRef={viewHeading}
        animate={animate}
      />
    );
  } else if (layout === 'three-columns') {
    // With nothing open, the column stays, so the layout doesn't jump.
    sessionView = (
      <section className="session-view-empty" aria-label="Session">
        <EmptyState icon="conversation" title="Select a session" sentence="Its conversation, terminal and actions open here." />
      </section>
    );
  }

  return (
    <ToastContext.Provider value={toasts.show}>
    <div className="app" ref={app} data-layout={layout}>
      {relayOff && <AppStrip off={relayOff} onDetails={relayAlert ? showRelayAlert : undefined} />}
      <Header
        state={state}
        roots={snapshot?.roots}
        updatedAt={snapshot ? updatedAt : undefined}
        onNewSession={snapshot ? () => setNewSession(true) : undefined}
        onRepos={layout === 'drawer' ? () => setDrawerOpen(true) : undefined}
        reposOpen={drawerOpen}
        reposRef={reposButton}
        onShortcuts={() => setShortcutsOpen(true)}
      />

      <div className="columns">
        {layout !== 'drawer' && repoList('list')}
        <HighlightContext.Provider value={filterNeedle(filters.text)}>
          <SessionList
            alerts={hasAlerts ? alerts : undefined}
            heading={heading}
            headingRef={listHeading}
            summary={snapshot && scope ? { total, shown, attention: countAttention(listed.current.map(({ session }) => session)) } : undefined}
            filters={
              allSessions.length > 0 && (
                <FilterControls filters={filters} onChange={setFilters} fieldRef={filterField}>
                  <SortSelect value={sort} onChange={setSort} />
                </FilterControls>
              )
            }
            current={current}
            finished={finished}
            empty={empty}
            finishedCollapsed={!(finishedId !== undefined && (finishedOpen.get(finishedId) ?? false))}
            onToggleFinished={toggleFinished}
            showGroup={scope !== undefined && scope.kind !== 'group'}
            holdOrder={sort !== 'name'}
            orderKey={`${selectionHref(selection)}|${sort}`}
            onOpen={openSession}
            onStep={stepFromRow}
            openSessionId={openId}
            inert={overlaid}
          />
        </HighlightContext.Provider>
        {/* The third column from 1,200 px; below that, display: contents, and the view overlays the list. */}
        <div className="session-pane">
          {layout === 'three-columns' && <Divider storage={storage} />}
          {sessionView}
        </div>
      </div>

      {layout === 'drawer' && drawerOpen && <RepoDrawer onClose={closeDrawer}>{repoList('drawer')}</RepoDrawer>}

      {newSession && snapshot && (
        <NewSessionDialog
          snapshot={snapshot}
          onClose={() => setNewSession(false)}
          onStarted={(session) => {
            setNewSession(false);
            started.wait(session);
            toasts.show({ tone: 'success', message: startedText(session.name) });
          }}
        />
      )}

      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}

      {/* Last, so it's above everything; focus that a dismissed toast had goes to the list's heading, or the view's while it covers the list. */}
      <ToastRegion {...toasts.region} onFocusLost={focusList} />
    </div>
    </ToastContext.Provider>
  );
}
