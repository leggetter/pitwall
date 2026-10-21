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
// A group can be hidden from the repo list with the session list header's Hide from repo list button,
// and shown again there or from the Hidden section at the list's foot (W35, hidden.ts). Hiding changes
// the repo list alone: the views, their counts, other groups and the session view are as they were.
// Each hide and unhide is confirmed by a toast that says where the group went, and the button keeps
// focus, as the same button with its other name.
//
// The single-key shortcuts (6.2) are handled here: `/` focuses the filter field, `n` opens the New
// session dialog, `?` the keyboard shortcuts dialog, and `j` and `k` move through the session list as
// shown. shortcuts.ts says which key is which, and when a key isn't one, such as while typing; here,
// they act only on this dashboard's keys, never over a dialog or the repo drawer, and only while
// they're on. One that moves focus closes an open menu first.
//
// With two or more roots, the header has a tab per root (W38, rootTabs.ts), and the open tab narrows
// the repo list, the session list, the filter, `j` and `k`, and the New session dialog to its root.
// Each tab keeps its own place, its selection, its open session and its filter, and the open session
// views of the tabs that aren't open stay mounted, hidden, so switching never detaches a terminal,
// drops a draft, or stops a send or an action in flight. The header, the page alerts, the app strip,
// the toasts, the Sort setting and the document title's count are the whole page's. Switching tabs
// pushes one history entry, with the tab's selection and open session; the back button switches back.

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SessionSummary } from '../../../src/shared/protocol.js';
import type { ConnectionView } from '../connection.js';
import { formatRoots, plainText, shortenHome } from '../format.js';
import { browserStorage, FINISHED_STATE_KEY, readGroupState, writeGroupState, type GroupState, type StorageSource } from '../groupState.js';
import { absentGroup, useHiddenGroups, type HiddenGroup } from '../hidden.js';
import { useLayout } from '../layout.js';
import { useOpenSession, withSession } from '../openSession.js';
import { createPanelWidthStore } from '../panelWidth.js';
import { relayAlertText } from '../relay.js';
import { tabAttention, tabGroups, writeStoredTab } from '../rootTabs.js';
import {
  browserNavigation,
  findGroup,
  finishedStateId,
  sameSelection,
  scopeFor,
  selectionHref,
  selectionName,
  useSelection,
  viewIn,
  withSelection,
  writeStoredSelection,
  type NavigationEnv,
  type Selection,
} from '../selection.js';
import {
  countAttention,
  filterListed,
  filterNeedle,
  groupId,
  groupLabel,
  listScope,
  NO_FILTERS,
  noMatchText,
  sessionsIn,
  startGroup,
  startLabel,
  workedInLabels,
  type Filters,
} from '../sessions.js';
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
import { HideButton } from './HideButton.js';
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

/** The empty state's sentence for a selected group that has left the snapshot, a root's own included (4: Empty states). */
export const GROUP_GONE = 'Its sessions are no longer listed under these roots.';

/** The toast once the server has started a session (5: Success). */
export const startedText = (name: string) => `Started ${plainText(name)}. Its view opens when it shows up in the list.`;

/** The toasts for hiding a group from the repo list and showing it again, saying where it went (W35). */
export const hiddenText = (label: string) => `Hid ${plainText(label)}. It's under Hidden, at the foot of the repo list.`;
export const unhiddenText = (label: string, listed: boolean) =>
  `Unhid ${plainText(label)}. ${listed ? "It's back in the repo list." : "It's back in the repo list once it has sessions."}`;

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
  // The session view's width as the third column: the divider and the actions menu's width items change it.
  const [panelWidth] = useState(() => createPanelWidthStore(storage));
  // With two or more roots, `tab` is the open root tab: the selection's root (W38).
  const [selection, choose, { tab, follow: followSelection }] = useSelection(snapshot, { navigation, storage });
  // Each root tab's own filter; with one root, the one filter.
  const [filtersByTab, setFiltersByTab] = useState<ReadonlyMap<string, Filters>>(() => new Map());
  const filterKey = tab ?? '';
  const filters = filtersByTab.get(filterKey) ?? NO_FILTERS;
  const setFilters = useCallback((next: Filters) => setFiltersByTab((current) => new Map(current).set(filterKey, next)), [filterKey]);
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
  // Which open session views have a draft in the message box: no shortcut replaces or closes the view
  // then, just as Escape doesn't (6.2). By session, since each root tab keeps its view (W38).
  const drafts = useRef(new Map<string, boolean>());
  // Which have a Stop or Remove running: j, k, ↑ and ↓ wait for it, so its result isn't moved away from (6.2).
  const running = useRef(new Map<string, boolean>());
  const hasDraft = (sessionId = openId) => sessionId !== undefined && (drafts.current.get(sessionId) ?? false);
  /** Whether changing a session's view now would lose something: a draft, or a running action's place. The open one's, by default. */
  const holding = (sessionId = openId) => hasDraft(sessionId) || (sessionId !== undefined && (running.current.get(sessionId) ?? false));

  // Before the first snapshot: the skeletons after --pw-delay-spinner, and what's slow after --pw-delay-long.
  const waiting = useWaiting(app, snapshot === undefined);
  const slow = slowFirstSnapshot(state);

  // Every root's groups, and the open root tab's alone (W38): those the index put under its root.
  const groups = snapshot?.groups ?? [];
  const roots = snapshot?.roots ?? [];
  const shownGroups = useMemo(() => tabGroups(groups, tab), [groups, tab]);
  // Each session is in one group, the one it started in (W39), and so in one root tab.
  // Every root's, for the open session and the document title; the open tab's, for the lists.
  const everySession = useMemo(() => sessionsIn(groups), [groups]);
  const allSessions = useMemo(() => (tab === undefined ? everySession : sessionsIn(shownGroups)), [tab, everySession, shownGroups]);
  const attention = countAttention(everySession);
  const selectedGroup = findGroup(groups, selection);
  // Groups hidden from the repo list, under these roots, whether or not they're in the snapshot (W35).
  // The repo list shows the open tab's.
  const hidden = useHiddenGroups(roots, storage);
  const shownHidden = tab === undefined ? hidden.groups : hidden.groups.filter((group) => group.root === tab);
  const selectedHidden = 'view' in selection ? undefined : hidden.find(selection.repo, selection.root);
  const scope = scopeFor(shownGroups, selection);
  const listed = useMemo(() => (scope ? listScope(shownGroups, scope, sort) : { current: [], finished: [] }), [shownGroups, scope?.kind, selectedGroup, sort]);
  const current = useMemo(() => filterListed(listed.current, filters), [listed, filters]);
  const finished = useMemo(() => filterListed(listed.finished, filters), [listed, filters]);
  // What pitwall last knew of each session, for one that leaves the snapshot while it's open, or that
  // the back button returns to: the view keeps showing it, and says it's no longer listed.
  const known = useRef(new Map<string, SessionSummary>());
  useEffect(() => {
    for (const session of everySession) known.current.set(session.sessionId, session);
  }, [everySession]);
  const listedSession = (sessionId: string) => everySession.find((session) => session.sessionId === sessionId);
  const listedOpen = openId === undefined ? undefined : listedSession(openId);
  const shownOpen = listedOpen ?? (openId === undefined ? undefined : known.current.get(openId));

  // Each root tab's place, its selection and its open session, as it was last left (W38). The open
  // tab's is the URL's; the others' are kept here for switching back, and their open session views
  // stay mounted, hidden.
  const [places, setPlaces] = useState<ReadonlyMap<string, { selection: Selection; session: string | undefined }>>(() => new Map());
  useEffect(() => {
    if (tab === undefined) return;
    setPlaces((current) => {
      const was = current.get(tab);
      if (was && was.session === openId && sameSelection(was.selection, selection)) return current;
      return new Map(current).set(tab, { selection, session: openId });
    });
  }, [tab, selection, openId]);
  /** Closes a tab's open session while that tab isn't open, as a Remove that finished there does. */
  const closeIn = useCallback((root: string) => {
    setPlaces((current) => {
      const was = current.get(root);
      return was && was.session !== undefined ? new Map(current).set(root, { ...was, session: undefined }) : current;
    });
  }, []);
  // Below 1,200 px the open session's view covers the session list, and below 1,000 px part of the
  // repo list beside it too (3: Session view). What it covers is inert while it's open, so nothing
  // hidden takes focus or a click. The header stays usable above it, and j and k still change the session.
  const overlaid = layout !== 'three-columns' && openId !== undefined;
  const reposCovered = overlaid && overlayCoversRepos;
  // The New session dialog, and the session it started, opened once it's listed.
  const [newSession, setNewSession] = useState(false);
  // Its view takes no focus, unless focus has nowhere to be: started from the no-sessions empty state,
  // whose New session button goes as the session is listed, focus would otherwise be left on the page.
  // Started in a root tab that has since been left, it opens there instead, for when that tab is back,
  // unless the view open there has a draft or a running action, which it would replace (W38).
  const openStarted = useCallback(
    (session: SessionSummary) => {
      const root = startGroup(groups, session)?.root;
      if (tab !== undefined && root !== undefined && root !== tab) {
        const there = places.get(root)?.session;
        if (there !== undefined && holding(there)) return;
        setPlaces((current) => new Map(current).set(root, { selection: current.get(root)?.selection ?? viewIn('all', root), session: session.sessionId }));
        return;
      }
      const active = document.activeElement;
      if (active === null || active === document.body) focusView.current = { id: session.sessionId, on: 'heading' };
      opened.open(session.sessionId);
    },
    [opened.open, groups, tab, places],
  );
  const started = useOpenWhenListed(everySession, openStarted);

  // The view's heading, which takes focus when a session is opened from a row or the view's header;
  // or its conversation, when `j` or `k` was pressed there, so ↑ and ↓ go on scrolling it.
  const viewHeading = useRef<HTMLHeadingElement>(null);
  const focusView = useRef<{ id: string; on: 'heading' | 'conversation' } | undefined>(undefined);
  useEffect(() => {
    const target = focusView.current;
    if (target === undefined || target.id !== openId) return;
    focusView.current = undefined;
    // The shown view's, not one kept hidden for another root tab (W38).
    const conversation = target.on === 'conversation' ? app.current?.querySelector<HTMLElement>('section.session-view:not([hidden]) .session-view-body[role="tabpanel"]') : undefined;
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
  // Where focus goes once the view over the list has closed, in place of the session's row: the filter
  // field after `/`, or the relay alert after Details, which the view covered until then.
  const focusAfterClose = useRef<(() => void) | undefined>(undefined);
  const closeSession = useCallback(() => {
    returnFocus.current = openId;
    opened.close();
  }, [openId, opened.close]);

  const previousOpen = useRef(openId);
  // The root tab the previous render showed: a session that goes with its tab hasn't been closed.
  const previousTab = useRef(tab);
  useEffect(() => {
    const was = previousOpen.current;
    previousOpen.current = openId;
    const switched = previousTab.current !== tab;
    previousTab.current = tab;
    if (was === undefined || openId !== undefined || switched) return;
    const asked = returnFocus.current === was;
    returnFocus.current = undefined;
    const instead = focusAfterClose.current;
    focusAfterClose.current = undefined;
    if (instead) {
      // After the commit that closed it, so what the view covered is no longer inert.
      instead();
      return;
    }
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
  }, [openId, layout, tab]);

  // The count is every root's, each session once, so what needs you under a tab that isn't open shows
  // in the browser's tab too; with root tabs, the open one's root follows the name (W38).
  useEffect(() => {
    document.title = `${attention > 0 ? `(${attention}) ` : ''}pitwall${tab === undefined ? '' : ` · ${plainText(shortenHome(tab))}`}`;
    return () => {
      document.title = 'pitwall';
    };
  }, [attention, tab]);

  // The open root tab is remembered for a URL with no selection, as the one the CLI opens (W38).
  useEffect(() => {
    if (tab !== undefined) writeStoredTab(tab, storage);
  }, [tab, storage]);

  // Switching root tabs: one history entry with the tab's own place, its selection and open session,
  // or All sessions the first time. Focus stays on the tab (W38).
  const tabsId = useId();
  const tabId = (root: string) => `${tabsId}-tab-${roots.indexOf(root)}`;
  const panelId = `${tabsId}-panel`;
  const switchTab = (root: string) => {
    if (tab === undefined || root === tab || !roots.includes(root)) return;
    const place = places.get(root) ?? { selection: viewIn('all', root), session: undefined };
    const { pathname, search, hash } = navigation.location;
    navigation.history.pushState(navigation.history.state, '', `${pathname}${withSession(withSelection(search, place.selection), place.session)}${hash}`);
    writeStoredSelection(place.selection, storage);
    followSelection();
    opened.follow();
  };
  // The back button can switch tabs too. Focus in what that hid, the last tab's session view, or
  // dropped to the page, goes to the open tab, before the browser would leave it on the page.
  const shownTab = useRef(tab);
  useLayoutEffect(() => {
    const was = shownTab.current;
    shownTab.current = tab;
    if (was === undefined || tab === undefined || was === tab) return;
    const active = document.activeElement;
    const lost = active === null || active === document.body || !active.isConnected || active.closest('[hidden]') !== null;
    if (lost) focusQuietly(app.current?.querySelector<HTMLElement>('.root-tab[aria-selected="true"]'));
  }, [tab]);

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
  // as Close would, unless the message box has a draft; focus goes to the field, not the row, once the
  // close has made the list usable again.
  const focusFilter = (root: HTMLElement): boolean => {
    const field = filterField.current;
    if (!field) return false;
    if (overlaid && hasDraft()) return false;
    closeMenus(root);
    const place = () => {
      field.focus();
      try {
        field.setSelectionRange(field.value.length, field.value.length);
      } catch {
        // A field that can't place the caret keeps it where the browser put it.
      }
    };
    if (overlaid) {
      focusAfterClose.current = place;
      opened.close();
    } else {
      place();
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
    if (overlaid && hasDraft()) return;
    if (overlaid) {
      // The alert's own effect focuses it; the row doesn't take focus back meanwhile.
      focusAfterClose.current = () => {};
      opened.close();
    }
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

  const name = selectionName(groups, selection, roots);
  const heading: SessionListHeading =
    'view' in selection
      ? { label: name }
      : { label: name, kind: selectedGroup?.kind ?? selectedHidden?.kind };
  // A group's Hide from repo list, or Show in repo list once it's hidden, whether or not it's in the snapshot.
  const unhide = (group: HiddenGroup) => {
    hidden.unhide(group);
    const listed = groups.some((candidate) => candidate.root === group.root && candidate.key === group.key);
    toasts.show({ tone: 'success', message: unhiddenText(groupLabel(absentGroup(group)), listed) });
  };
  let headingAction: ReactNode;
  if (selectedHidden) {
    const group = selectedHidden;
    headingAction = (
      <HideButton
        hidden
        onClick={() => {
          unhide(group);
          // A group that has left the snapshot can't be hidden again, so the button goes: focus goes to the heading, not the page.
          if (!selectedGroup) listHeading.current?.focus();
        }}
      />
    );
  } else if (selectedGroup) {
    const group = selectedGroup;
    headingAction = (
      <HideButton
        hidden={false}
        onClick={() => {
          hidden.hide(group);
          toasts.show({ tone: 'success', message: hiddenText(groupLabel(group)) });
        }}
      />
    );
  }
  const total = listed.current.length + listed.finished.length;
  const shown = current.length + finished.length;
  // No summary where it would only repeat the empty state below it: "0 sessions · Nothing needs you"
  // over no sessions at all, or "Nothing needs you" over Needs you's own "Nothing needs you right now".
  const summarised = snapshot !== undefined && scope !== undefined && allSessions.length > 0 && !(scope.kind === 'needs-you' && total === 0);
  // The empty states' actions take their button away, so focus goes where the reader carries on: the
  // filter field after a filter action, the session list's heading otherwise.
  const focusField = () => filterField.current?.focus();
  const showAll = (
    <Button
      onClick={() => {
        select(viewIn('all', tab));
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
        title={`No Claude Code sessions under ${plainText(formatRoots(tab === undefined ? snapshot.roots : [tab]))}`}
        sentence="Start one here, or start Claude Code in any terminal under these directories and it appears here."
        actions={
          <Button variant="primary" icon="add" aria-haspopup="dialog" onClick={() => setNewSession(true)}>
            New session
          </Button>
        }
      />
    );
  } else if (!scope) {
    // A group, a root's own included, goes once no session started in it is listed.
    empty = (
      <EmptyState
        icon="directory"
        title={`No sessions in ${plainText(name)} now`}
        sentence={GROUP_GONE}
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
                  select(viewIn('all', tab));
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
      groups={snapshot ? shownGroups : undefined}
      roots={roots}
      selection={selection}
      onSelect={(next) => select(next, from)}
      autoFocus={from === 'drawer'}
      skeletons={waiting.shown}
      inert={from === 'list' && reposCovered}
      hidden={{ groups: shownHidden, open: hidden.open, onToggle: () => hidden.setOpen(!hidden.open), onUnhide: unhide }}
      tab={tab}
    />
  );

  // The open session's view, the same element in every layout so it's never remounted. It slides in
  // only when it opens, not when it goes from one session to the next.
  const viewLayout = layout === 'three-columns' ? 'column' : 'overlay';
  // Not when a root tab is switched to: its view was there all along, hidden.
  const animate = previousOpen.current === undefined && previousTab.current === tab;
  /**
   * A session's view: the open one, or, `hiddenIn` another root tab, that tab's, kept hidden (W38).
   * Keyed by the session alone, so switching tabs only hides or shows a view, never remounts it.
   */
  const viewOf = (session: SessionSummary, hiddenIn?: string) => (
    <SessionView
      key={session.sessionId}
      session={session}
      placement={{ startedIn: startLabel(groups, session), workedIn: workedInLabels(session, roots) }}
      listed={listedSession(session.sessionId) !== undefined}
      onClose={hiddenIn === undefined ? closeSession : () => closeIn(hiddenIn)}
      layout={viewLayout}
      compact={compact}
      headingRef={hiddenIn === undefined ? viewHeading : undefined}
      onStep={hiddenIn === undefined ? stepFromView : undefined}
      panel={layout === 'three-columns' ? panelWidth : undefined}
      animate={hiddenIn === undefined && animate}
      hidden={hiddenIn !== undefined}
      onDraftChange={(has) => {
        drafts.current.set(session.sessionId, has);
      }}
      onRunningChange={(busy) => {
        running.current.set(session.sessionId, busy);
      }}
    />
  );
  let sessionView: ReactNode;
  if (shownOpen) {
    sessionView = viewOf(shownOpen);
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
      <section key="nothing-open" className="session-view-empty" aria-label="Session">
        <EmptyState icon="conversation" title="Select a session" sentence="Its conversation, terminal and actions open here." />
      </section>
    );
  }
  // The other root tabs' open sessions, hidden, in their tabs' order, with the open tab's view in its
  // own tab's place, so switching tabs moves nothing in the page (W38). A session a URL opened in two
  // tabs has one view, the open tab's when it's one of them.
  const paneViews: ReactNode[] = [];
  if (tab === undefined) paneViews.push(sessionView);
  else {
    const placed = new Set(openId === undefined ? [] : [openId]);
    for (const root of roots) {
      if (root === tab) {
        paneViews.push(sessionView);
        continue;
      }
      const id = places.get(root)?.session;
      const session = id === undefined || placed.has(id) ? undefined : (listedSession(id) ?? known.current.get(id));
      if (!session) continue;
      placed.add(session.sessionId);
      paneViews.push(viewOf(session, root));
    }
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
        tabs={
          tab === undefined
            ? undefined
            : { tabs: roots.map((root) => ({ root, attention: tabAttention(groups, root) })), active: tab, onSelect: switchTab, panelId, tabId }
        }
      />

      {/* With root tabs, the columns are the open tab's panel, named by it. */}
      <div className="columns" {...(tab === undefined ? {} : { role: 'tabpanel', id: panelId, 'aria-labelledby': tabId(tab) })}>
        {layout !== 'drawer' && repoList('list')}
        <HighlightContext.Provider value={filterNeedle(filters.text)}>
          <SessionList
            alerts={hasAlerts ? alerts : undefined}
            heading={heading}
            headingRef={listHeading}
            headingAction={headingAction}
            summary={summarised ? { total, shown, attention: countAttention(listed.current.map(({ session }) => session)) } : undefined}
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
          {layout === 'three-columns' && <Divider store={panelWidth} />}
          {paneViews}
        </div>
      </div>

      {layout === 'drawer' && drawerOpen && <RepoDrawer onClose={closeDrawer}>{repoList('drawer')}</RepoDrawer>}

      {newSession && snapshot && (
        <NewSessionDialog
          snapshot={snapshot}
          tab={tab}
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
