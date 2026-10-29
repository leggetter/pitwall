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
// Sessions can be starred (W53, starred.ts), from the star toggle on each row and in the session
// view's header, and the repo list's Starred view lists the starred sessions under the open root tab.
// Starring never selects or opens a session. Unstarred in Starred, a row leaves at once, and focus
// goes to the star toggle of the row that took its place (SessionList.tsx).
//
// A session that needs you can be marked not needed now (W88, notNeeded.ts), from the toggle on its
// row or its view's actions menu, and it leaves everything needsAttention() drives: Needs you, the
// repo list's badges, the session list's "N need you", the root tabs' badges, the document title's
// count and the urgency sort. Each snapshot drops the marks whose sessions need something else now,
// so they're back in Needs you by themselves. Each mark says so in a toast with Undo; a row marked in
// Needs you leaves at once, and focus goes to the toggle of the row that took its place.
//
// The single-key shortcuts (6.2) are handled here: `/` focuses the filter field, `n` opens the New
// session dialog, `?` the keyboard shortcuts dialog, `j` and `k` move through the session list as
// shown, and `s` stars or unstars the open session, with a toast, since focus isn't on its toggle. shortcuts.ts says which key is which, and when a key isn't one, such as while typing; here,
// they act only on this dashboard's keys, never over a dialog or the repo drawer, and only while
// they're on. One that moves focus closes an open menu first.
//
// Preferences (W59, Preferences.tsx), from the header, sets how sessions are grouped (W42,
// groupBy.ts): Main repo, the default, Where it started, or Every repo it worked in. The page
// groups the snapshot for the chosen mode, and everything that lists groups or sessions, the repo
// list, the views, the root tabs and their badges, ?session= and the document title, uses those
// groups, each session counted once. The session view's "Started in" line and the New session
// dialog's directories use the snapshot's own, where each session started. A switch keeps the
// selected group when the new mode has it; when it hasn't, All sessions in the same root tab is
// selected instead, a toast says so, and focus stays on the choice in Preferences. An open session
// view stays open.
//
// Preferences also sets which tab a running background session's view opens on: Terminal, the
// default, or Conversation (W54, backgroundTab.ts), which the view reads as it opens. Stepping onto a
// session with `j`, `k`, ↑ or ↓ tells its view so, and a terminal it opens on waits a moment before
// attaching, so passing through attaches nothing. A click or Enter on a row tells the view it opened
// so too, and only then may its terminal take focus as it attaches (W57), unless Preferences says
// never. The dialog is rendered here, as the other dialogs are, and changes the Dashboard's own
// settings, so the views read what it sets.
//
// With two or more roots, the header has a tab per root (W38, rootTabs.ts), and the open tab narrows
// the repo list, the session list, the filter, `j` and `k`, and the New session dialog to its root.
// Each tab keeps its own place, its selection, its open session and its filter, and the open session
// views of the tabs that aren't open stay mounted, hidden, so switching never detaches a terminal,
// drops a draft, or stops a send or an action in flight. The header, the page alerts, the app strip,
// the toasts, the Sort setting and the document title's count are the whole page's. Switching tabs
// pushes one history entry, with the tab's selection and open session; the back button switches back.
//
// A session started from New session is selected once it's listed (W63): its root tab, the group the
// repo list lists it under in the viewer's Group sessions by, and its view, in one pushed history
// entry, as opening a row pushes one. Its terminal takes no focus (W57), and focus stays where it was
// unless the switch took it away. Not over what you're in the middle of, though: a draft, a running
// Stop or Remove, an open confirmation or restart prompt, in the view open here or in the session's
// tab, or typing in the columns. Then a toast says it's listed, with Open, in place of the one that
// said it started.
//
// Ended interactive sessions (W67) are listed in their groups' Finished sections. Those last active
// more than ENDED_SHOWN_DAYS before the snapshot's time are left out of the snapshot's groups here,
// before anything groups or counts them, so every list, count, badge and the repo list leave them out,
// and a group with nothing else goes from the repo list, until Show older is on: one switch for the
// page, in the selection's Finished section and its empty states, never stored. The session view finds
// a session among all of them, so one that's hidden still shows in a view that's open, or a URL's.
//
// Pull requests (M4, W95), under Starred in the repo list, lists your open PRs in the session list's
// column (PrList.tsx), from the connection's latest 'prs' message, and opens one in the session view's
// place (PrView.tsx), as ?pr= (openPr.ts). The third column shows one thing: a PR opened takes the
// place of the open session, and a session opened takes the place of the open PR, each in one pushed
// history entry, so the back button goes back to the other. Neither changes the selection, as opening
// a session never has: a PR's view opens over the session list from a session's link, and a session's
// view over the PR list from the PR's Sessions. The PR list's filter, Show older and Refresh are the
// page's, whatever the root tab, since PRs aren't under a root; its collapsed repos are remembered
// (prRepos.ts). `j` and `k`, and ↑ and ↓ on a row or in the view's header, step through the PR list
// as they do the session list. Each session row has a badge for its most urgent strongly linked open
// PR, and its view's header links to each one.

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PullRequestRelation, PullRequestSummary, SessionSummary } from '../../../src/shared/protocol.js';
import { useBackgroundTab } from '../backgroundTab.js';
import type { ConnectionView } from '../connection.js';
import { focusGesture, type FocusGesture } from '../focusGesture.js';
import { useTerminalFocus } from '../terminalFocus.js';
import { formatRoots, plainText, shortenHome } from '../format.js';
import { everyGroupId, groupByPhrase, groupSessions, useGroupBy, type GroupBy } from '../groupBy.js';
import { browserStorage, FINISHED_STATE_KEY, readGroupState, writeGroupState, type GroupState, type StorageSource } from '../groupState.js';
import { absentGroup, useHiddenGroups, type HiddenGroup } from '../hidden.js';
import { useLayout } from '../layout.js';
import { useNotNeeded } from '../notNeeded.js';
import { useOpenSession, withSession, type OpenSession } from '../openSession.js';
import { useOpenPr, withPr } from '../openPr.js';
import { usePrRefresh } from '../prRefresh.js';
import { usePrRepos } from '../prRepos.js';
import { countPrAttention, listNow, prKey, prListState, prsBySession, prsOff, sessionsFor, splitPrs } from '../prs.js';
import { createPanelWidthStore } from '../panelWidth.js';
import { relayAlertText } from '../relay.js';
import { tabAttention, tabGroups, writeStoredTab } from '../rootTabs.js';
import {
  browserNavigation,
  findGroup,
  finishedStateId,
  groupSelection,
  isPrsSelection,
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
  groupLabel,
  isOlderEnded,
  listScope,
  needsAttention,
  NO_FILTERS,
  noMatchText,
  sessionsIn,
  startLabel,
  withoutOlderEnded,
  workedInLabels,
  type Filters,
} from '../sessions.js';
import { useSort } from '../sort.js';
import { isTyping, shortcutFor, useShortcutsStore, type Shortcut } from '../shortcuts.js';
import { useStarred } from '../starred.js';
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
import { PrList } from './PrList.js';
import { PrView, UnlistedPrView, WaitingPrView, type PrMissing } from './PrView.js';
import { PreferencesDialog } from './Preferences.js';
import { RepoDrawer } from './RepoDrawer.js';
import { RepoList } from './RepoList.js';
import { olderText, SessionList, type SessionListHeading } from './SessionList.js';
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

/**
 * The empty state's sentence for a root's own group that the snapshot still has, but Group sessions
 * by, in Preferences, doesn't: every session started there worked in repos, so it's listed under them (W42).
 */
export const groupMovedText = (mode: GroupBy) =>
  `Its sessions are listed under the repos they ${mode === 'main-repo' ? 'changed most' : 'worked in'}, as Preferences groups them.`;

/** The toast once the server has started a session (5: Success). */
export const startedText = (name: string) => `Started ${plainText(name)}. Its view opens when it shows up in the list.`;

/**
 * The toast once a started session is listed, when showing it would have taken over what you're in
 * the middle of (W63). It replaces the one that said it started, and has OPEN_LISTED.
 */
export const listedText = (name: string) => `${plainText(name)} is listed now. It didn't open, so you keep your place.`;

/** That toast's action: it selects and opens the session, as it would have been. */
export const OPEN_LISTED = 'Open';

/** What a started session's toasts are about, so the one that says it's listed replaces the one that said it started. */
const startedKey = (shortId: string) => `started:${shortId}`;

/** The toast for `s`, which stars or unstars the open session while focus is elsewhere (W53). */
export const starredText = (name: string, on: boolean) => `${on ? 'Starred' : 'Unstarred'} ${plainText(name)}.`;

/**
 * The toast once a session is marked not needed now (W88), with UNDO_NOT_NEEDED: it has left Needs you,
 * and says when it comes back.
 */
export const notNeededText = (name: string) => `Marked ${plainText(name)} not needed now. It comes back to Needs you when what it needs changes.`;

/** That toast's action: it takes the mark away, so the session is back in Needs you. */
export const UNDO_NOT_NEEDED = 'Undo';

/** The toast once the session view's Put back in Needs you takes a mark away, since the menu has closed (W88). */
export const putBackText = (name: string) => `Put ${plainText(name)} back in Needs you.`;

/** What a session's Not needed now toasts are about, so each replaces the last. */
const notNeededKey = (sessionId: string) => `not-needed:${sessionId}`;

/** Starred's empty state, with nothing starred under the root (W53, 4: Empty states). */
export const NO_STARRED = { title: 'No starred sessions', sentence: 'Star a session from its row or its view to keep it here.' } as const;

/** The toasts for hiding a group from the repo list and showing it again, saying where it went (W35). */
export const hiddenText = (label: string) => `Hid ${plainText(label)}. It's under Hidden, at the foot of the repo list.`;
export const unhiddenText = (label: string, listed: boolean) =>
  `Unhid ${plainText(label)}. ${listed ? "It's back in the repo list." : "It's back in the repo list once it has sessions."}`;

/**
 * The toast when a switch of Group sessions by leaves the selected group out of the repo list, so All
 * sessions is selected instead (W42).
 */
export const groupGoneText = (label: string, mode: GroupBy) =>
  `Selected All sessions: ${plainText(label)} has no sessions when grouped by ${groupByPhrase(mode)}.`;

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
  // Group sessions by, from Preferences (W42, W59): the snapshot's groups, grouped again for the mode.
  const [groupBy, setGroupBy] = useGroupBy(storage);
  // Which tab a running background session's view opens on, from Preferences too (W54).
  const [backgroundTab, setBackgroundTab] = useBackgroundTab(storage);
  // When a terminal may take the keyboard (W57): after you open it here, or never, from Preferences
  // too. One hook, so the setting the dialog changes is the one the views read at each attach.
  const [terminalFocus, setTerminalFocus] = useTerminalFocus(storage);
  const startGroups = snapshot?.groups;
  // Show older (W67): off at each load, and never stored (coordinator, W67).
  const [showOlder, setShowOlder] = useState(false);
  // "Now" for the ended sessions' window: the snapshot's own time, so what's hidden changes only with a snapshot.
  const endedNow = snapshot ? Date.parse(snapshot.generatedAt) : Number.NaN;
  // The snapshot's groups without the older ended sessions, unless Show older is on: what everything below lists and counts.
  const windowedGroups = useMemo(
    () => (startGroups === undefined || showOlder ? startGroups : withoutOlderEnded(startGroups, endedNow)),
    [startGroups, showOlder, endedNow],
  );
  const grouped = useMemo(() => groupSessions(windowedGroups ?? [], groupBy), [windowedGroups, groupBy]);
  // Every session, the older ended ones too: for the session view, and for Show older's counts.
  const groupedAll = useMemo(
    () => (windowedGroups === startGroups ? grouped : groupSessions(startGroups ?? [], groupBy)),
    [windowedGroups, startGroups, grouped, groupBy],
  );
  const anyOlder = useMemo(() => (startGroups ?? []).some((group) => group.sessions.some((session) => isOlderEnded(session, endedNow))), [startGroups, endedNow]);
  // The New session dialog's directories are the repo list's groups', so not a group of older ended sessions alone.
  const dialogSnapshot = useMemo(() => (snapshot && windowedGroups ? { roots: snapshot.roots, groups: windowedGroups } : undefined), [snapshot, windowedGroups]);
  const viewSnapshot = useMemo(() => (snapshot ? { roots: snapshot.roots, groups: grouped.groups } : undefined), [snapshot, grouped]);
  // With two or more roots, `tab` is the open root tab: the selection's root (W38).
  const [selection, choose, { tab, follow: followSelection }] = useSelection(viewSnapshot, { navigation, storage, home: grouped.home });
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
  const sessionUrl = useOpenSession(navigation);
  // The open pull request, from ?pr= (W95), which a session opened takes the place of, and the other way round.
  const prUrl = useOpenPr(navigation);
  const { follow: followPr } = prUrl;
  const { open: openInUrl, close: closeInUrl, follow: followSession } = sessionUrl;
  // Opening a session drops ?pr= from the URL, so the PR's state follows it.
  const opened = useMemo<OpenSession>(
    () => ({
      id: sessionUrl.id,
      open: (sessionId, mode) => {
        openInUrl(sessionId, mode);
        followPr();
      },
      close: closeInUrl,
      follow: () => {
        followSession();
        followPr();
      },
    }),
    [sessionUrl.id, openInUrl, closeInUrl, followSession, followPr],
  );
  const openId = opened.id;
  // The open PR's key, while no session is open in its place.
  const prOpen = openId === undefined ? prUrl.key : undefined;
  const prsSelected = isPrsSelection(selection);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const reposButton = useRef<HTMLButtonElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const filterField = useRef<HTMLInputElement>(null);
  const shortcuts = useShortcutsStore();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
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

  // Every root's groups as the chosen grouping has them, and the open root tab's alone (W38): those
  // under its root.
  const groups = grouped.groups;
  const roots = snapshot?.roots ?? [];
  const shownGroups = useMemo(() => tabGroups(groups, tab), [groups, tab]);
  // Each session once, whichever groups and root tabs list it. Every root's, for the open session and
  // the document title; the open tab's, for the lists.
  const everySession = useMemo(() => sessionsIn(groups), [groups]);
  const allSessions = useMemo(() => (tab === undefined ? everySession : sessionsIn(shownGroups)), [tab, everySession, shownGroups]);
  // The sessions marked not needed now (W88), every root's, whether or not they're in the snapshot.
  // Each snapshot drops those it lists as needing something else now; never those it doesn't list.
  const notNeeded = useNotNeeded(storage);
  const marks = notNeeded.entries;
  const { prune } = notNeeded;
  useEffect(() => {
    if (startGroups) prune(sessionsIn(startGroups));
  }, [startGroups, prune]);
  const attention = countAttention(everySession, marks);
  const selectedGroup = findGroup(groups, selection);
  // Groups hidden from the repo list, under these roots, whether or not they're in the snapshot (W35).
  // The repo list shows the open tab's.
  const hidden = useHiddenGroups(roots, storage);
  const shownHidden = tab === undefined ? hidden.groups : hidden.groups.filter((group) => group.root === tab);
  const selectedHidden = 'view' in selection ? undefined : hidden.find(selection.repo, selection.root);
  // The starred sessions' ids, every root's, whether or not they're in the snapshot (W53).
  const starred = useStarred(storage);
  const scope = scopeFor(shownGroups, selection, starred.set);
  const listed = useMemo(
    () => (scope ? listScope(shownGroups, scope, sort, grouped.home, marks) : { current: [], finished: [] }),
    [shownGroups, scope?.kind, selectedGroup, sort, grouped.home, starred.set, marks],
  );
  const current = useMemo(() => filterListed(listed.current, filters), [listed, filters]);
  const finished = useMemo(() => filterListed(listed.finished, filters), [listed, filters]);
  // The selection's ended sessions older than ENDED_SHOWN_DAYS (W67), as the filters show them, with
  // Show older on or off: how many its button says, and whether the selection has one at all.
  const olderCount = useMemo(() => {
    if (!anyOlder) return 0;
    const every = tabGroups(groupedAll.groups, tab);
    const everyScope = scopeFor(every, selection, starred.set);
    if (!everyScope) return 0;
    const older = listScope(every, everyScope, sort, groupedAll.home).finished.filter(({ session }) => isOlderEnded(session, endedNow));
    return filterListed(older, filters).length;
  }, [anyOlder, groupedAll, tab, selection, starred.set, sort, endedNow, filters]);
  // Every session pitwall lists, the older ended ones too, each once: the session view shows one
  // wherever it's listed, so Hide older never says an open one is no longer listed.
  const everyListed = useMemo(() => (groupedAll === grouped ? everySession : sessionsIn(groupedAll.groups)), [groupedAll, grouped, everySession]);
  // What pitwall last knew of each session, for one that leaves the snapshot while it's open, or that
  // the back button returns to: the view keeps showing it, and says it's no longer listed.
  const known = useRef(new Map<string, SessionSummary>());
  useEffect(() => {
    for (const session of everyListed) known.current.set(session.sessionId, session);
  }, [everyListed]);
  const listedSession = (sessionId: string) => everyListed.find((session) => session.sessionId === sessionId);
  const listedOpen = openId === undefined ? undefined : listedSession(openId);
  const shownOpen = listedOpen ?? (openId === undefined ? undefined : known.current.get(openId));

  // Your open pull requests (W95), the page's whatever the root tab: the latest 'prs' message's list.
  const prList = view.prs;
  const allPrs = useMemo(() => prList?.prs ?? [], [prList]);
  // The 90-day window, from the list's own time, so what's hidden changes only with a fetch.
  const prNow = listNow(prList, Number.NaN);
  const recentPrs = useMemo(() => splitPrs(allPrs, prNow).recent, [allPrs, prNow]);
  // The repo list's item, once the server has sent a list, unless pull requests are off.
  const repoListPrs =
    prList === undefined || prsOff(prList)
      ? undefined
      : { attention: countPrAttention(recentPrs), count: prList.fetchedAt === undefined || recentPrs.length === 0 ? undefined : recentPrs.length };
  // Each session's strongly linked open PRs, most urgent first, for its row's badge and its view's links.
  const linkedPrs = useMemo(() => prsBySession(everyListed, allPrs), [everyListed, allPrs]);
  const [prFilter, setPrFilter] = useState('');
  // The PR list's chips (W101): the page's, none on at each load, never stored, as the filter's text.
  const [prRelations, setPrRelations] = useState<ReadonlySet<PullRequestRelation>>(() => new Set());
  // Show older for PRs: off at each load, and never stored, as the ended sessions' is.
  const [showOlderPrs, setShowOlderPrs] = useState(false);
  const prRepos = usePrRepos(storage);
  const collapsedRepos = useMemo(() => new Set(allPrs.map((pr) => pr.repo).filter(prRepos.isCollapsed)), [allPrs, prRepos.isCollapsed]);
  const prRefresh = usePrRefresh(toasts.show);
  // What the page last knew of each PR, for one that leaves the list while it's open, merged or closed.
  const knownPrs = useRef(new Map<string, PullRequestSummary>());
  useEffect(() => {
    for (const pr of allPrs) knownPrs.current.set(prKey(pr), pr);
  }, [allPrs]);
  const listedPr = prOpen === undefined ? undefined : allPrs.find((pr) => prKey(pr) === prOpen);
  const shownPr = listedPr ?? (prOpen === undefined ? undefined : knownPrs.current.get(prOpen));
  const prState = prListState(prList);
  // Why an open PR the latest list doesn't have shows what it showed last: gone only from a list
  // fetched since, never from the empty list a restart's poller sends before its first fetch.
  const prMissing: PrMissing | undefined =
    listedPr !== undefined ? undefined : prState.kind === 'list' ? 'gone' : prState.kind === 'off' ? 'off' : prState.kind === 'failed' ? 'failed' : undefined;
  // Pull requests off, as after a restart with --no-prs, with Pull requests selected, as a stored
  // selection from an earlier run can have it: the repo list has no item to show it selected, so
  // All sessions in the same root tab takes its place, replacing the history entry. A ?pr= stays,
  // and its view says pull requests are off.
  const prsOffNow = prState.kind === 'off';
  useEffect(() => {
    if (!prsSelected || !prsOffNow) return;
    const instead = viewIn('all', tab);
    const { pathname, search, hash } = navigation.location;
    navigation.history.replaceState(navigation.history.state, '', `${pathname}${withSelection(search, instead)}${hash}`);
    writeStoredSelection(instead, storage);
    followSelection();
  }, [prsSelected, prsOffNow, tab, navigation, storage, followSelection]);
  // A ?pr= before the list says what it is: the view's skeletons after --pw-delay-spinner.
  const prWaiting = useWaiting(app, prOpen !== undefined && shownPr === undefined && prState.kind === 'loading');

  // Each root tab's place, its selection and its open session, as it was last left (W38). The open
  // tab's is the URL's; the others' are kept here for switching back, and their open session views
  // stay mounted, hidden.
  const [places, setPlaces] = useState<ReadonlyMap<string, { selection: Selection; session: string | undefined; pr?: string | undefined }>>(() => new Map());
  useEffect(() => {
    if (tab === undefined) return;
    setPlaces((current) => {
      const was = current.get(tab);
      if (was && was.session === openId && was.pr === prOpen && sameSelection(was.selection, selection)) return current;
      return new Map(current).set(tab, { selection, session: openId, pr: prOpen });
    });
  }, [tab, selection, openId, prOpen]);
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
  const overlaid = layout !== 'three-columns' && (openId !== undefined || prOpen !== undefined);
  const reposCovered = overlaid && overlayCoversRepos;
  // The New session dialog, and the session it started, selected once it's listed (W63).
  const [newSession, setNewSession] = useState(false);
  // Which open session views have a question open, a Stop or Remove confirmation or the terminal's
  // restart prompt: a started session doesn't replace them (W63). By session, as drafts are.
  const prompts = useRef(new Map<string, boolean>());
  /**
   * Whether showing a started session in this session's place would take over what you're in the
   * middle of (W63): what holding() keeps, a draft or a running Stop or Remove, or a question open in
   * its view.
   */
  const keepsPlace = (sessionId: string | undefined) => sessionId !== undefined && (holding(sessionId) || (prompts.current.get(sessionId) ?? false));
  /** Typing in the columns, where single-key shortcuts are off: the filter, the message box, the terminal. Not in a dialog, which a switch leaves alone. */
  const typingHere = () => {
    const active = document.activeElement;
    return active instanceof Element && isTyping(active) && active.closest('.columns') !== null && app.current?.contains(active) === true;
  };
  /**
   * Shows a session New session started (W63): its root tab; its group, the one the repo list lists
   * it under in the viewer's Group sessions by, which is its home group (groupBy.ts), as a ?session=
   * link selects it too; and its view, which its row marks as open. One history entry, pushed, as
   * opening a row pushes one, so the back button goes back to where you were. Its terminal takes no
   * focus (W57): nothing in the page asked for it.
   *
   * Focus, with `kept`: it stays where it is, as when a view opens from the URL, unless the switch took
   * away or hid what had it, as a row that's no longer listed, or it was on the page, as after the
   * no-sessions empty state's New session: then the view's heading takes it. With `heading`, from the
   * toast's Open, which goes with its toast, the heading takes it, as from a row (6.1, item 8).
   */
  const showStarted = (session: SessionSummary, focus: 'kept' | 'heading') => {
    const home = grouped.home.get(session.sessionId);
    const next = home ? groupSelection(home, roots) : selection;
    const active = document.activeElement;
    const unless = focus === 'kept' && active instanceof Element && active !== document.body && active !== document.documentElement ? active : undefined;
    focusView.current = unless === undefined ? { id: session.sessionId, on: 'heading' } : { id: session.sessionId, on: 'heading', unless };
    const { pathname, search, hash } = navigation.location;
    navigation.history.pushState(navigation.history.state, '', `${pathname}${withSession(withSelection(search, next), session.sessionId)}${hash}`);
    writeStoredSelection(next, storage);
    followSelection();
    opened.follow();
  };
  // The toast's Open, whenever it's used: the session as it's listed then, or its view alone once it isn't.
  const listedToast = useRef<{ sessionId: string; key: string } | undefined>(undefined);
  const openListed = useRef<(sessionId: string) => void>(() => {});
  openListed.current = (sessionId) => {
    listedToast.current = undefined;
    const listed = listedSession(sessionId);
    if (listed) {
      showStarted(listed, 'heading');
      return;
    }
    focusView.current = { id: sessionId, on: 'heading' };
    opened.open(sessionId);
  };
  // Once it's listed: shown, unless that would take over the view open here, typing in the columns,
  // or the view open in its root tab, which it would replace. Then the toast that said it started
  // says it's listed, with Open.
  const openStarted = (session: SessionSummary) => {
    // The root of the group it's listed under: a session just started has worked in no repo yet, so where it started.
    const root = grouped.home.get(session.sessionId)?.root;
    const there = tab !== undefined && root !== undefined && root !== tab ? places.get(root)?.session : undefined;
    if (!keepsPlace(openId) && !typingHere() && !keepsPlace(there)) {
      showStarted(session, 'kept');
      return;
    }
    const key = startedKey(session.shortId ?? session.sessionId);
    listedToast.current = { sessionId: session.sessionId, key };
    toasts.show({ tone: 'info', key, message: listedText(session.name), action: { label: OPEN_LISTED, onAction: () => openListed.current(session.sessionId) } });
  };
  const started = useOpenWhenListed(everySession, openStarted);
  // Opened some other way, from its row say, the toast's Open has nothing left to do, so it goes.
  useEffect(() => {
    const shown = listedToast.current;
    if (shown === undefined || shown.sessionId !== openId) return;
    listedToast.current = undefined;
    toasts.dismiss(shown.key);
  }, [openId]);

  // The view's heading, which takes focus when a session is opened from a row or the view's header;
  // or its conversation, when `j` or `k` was pressed there, so ↑ and ↓ go on scrolling it. A view that
  // opened on its Terminal tab (W54) has its conversation hidden, so its heading takes focus instead.
  const viewHeading = useRef<HTMLHeadingElement>(null);
  // `unless`: what had focus as a started session was shown (W63), which keeps it while it's still in sight.
  const focusView = useRef<{ id: string; on: 'heading' | 'conversation'; unless?: Element } | undefined>(undefined);
  useEffect(() => {
    const target = focusView.current;
    if (target === undefined || target.id !== openId) return;
    focusView.current = undefined;
    const { unless } = target;
    if (unless !== undefined && unless.isConnected && unless.closest('[hidden], [inert]') === null) return;
    // The shown view's, not one kept hidden for another root tab (W38).
    const conversation =
      target.on === 'conversation' ? app.current?.querySelector<HTMLElement>('section.session-view:not([hidden]) .session-view-body[role="tabpanel"]:not([hidden])') : undefined;
    (conversation ?? viewHeading.current)?.focus();
  });

  // The session the last step, by `j`, `k`, ↑ or ↓, moved the open view to (W54): its view waits
  // before its terminal attaches, and its terminal takes no focus. Any other way of opening one,
  // a click, Enter, the URL or the back button, isn't a step.
  const stepped = useRef<string | undefined>(undefined);
  const stepTo = (sessionId: string) => {
    stepped.current = sessionId;
    opened.open(sessionId, 'replace');
  };
  useEffect(() => {
    if (stepped.current !== openId) stepped.current = undefined;
  }, [openId]);

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

  // The click or Enter on a row that opened the open session's view (W57, focusGesture.ts): a terminal
  // it opens on may take focus as it attaches, once, soon after. Any other way of opening a view, the
  // URL, a reload, back or forward, a root tab, a started session or a step, gives none, so its
  // terminal leaves focus where it is. It goes once another session is open, so back to this one
  // later gives none either.
  const opener = useRef<{ sessionId: string; gesture: FocusGesture } | undefined>(undefined);
  useEffect(() => {
    if (opener.current?.sessionId !== openId) opener.current = undefined;
  }, [openId]);

  // From a row, by a click or Enter: the view's heading takes focus (6.1, item 8).
  const openSession = useCallback(
    (sessionId: string) => {
      if (sessionId === openId) {
        viewHeading.current?.focus();
        return;
      }
      opener.current = { sessionId, gesture: focusGesture(rowButton(sessionId)) };
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
    if (openId !== undefined) stepTo(id);
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
    stepTo(id);
  };

  // `j` and `k`: the next or previous session in the list as shown, from the focused row, or else the
  // open session, or else the first row. With the view closed, focus moves to that row. With it open,
  // the view shows that session too: focus stays in the list if it was there, stays in the
  // conversation if it was there, and otherwise goes to the view's heading, as ↑ and ↓ in its header do.
  const stepByKey = (root: HTMLElement, by: 1 | -1): boolean => {
    const buttons = rowButtons();
    const active = document.activeElement;
    // A row's name button, its star toggle (W53), or its Not needed now toggle (W88).
    const toggleOf = active instanceof HTMLElement ? (active.dataset.starSession ?? active.dataset.notNeededSession) : undefined;
    const onRow =
      active instanceof HTMLElement && active.closest('.session-list') !== null
        ? buttons.includes(active)
          ? active.dataset.openSession
          : buttons.find((button) => toggleOf !== undefined && button.dataset.openSession === toggleOf)?.dataset.openSession
        : undefined;
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
    stepTo(id);
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
    // A PR's view that took its place isn't a close: it has focus of its own to give (W95).
    if (was === undefined || openId !== undefined || prOpen !== undefined || switched) return;
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
  }, [openId, layout, tab, prOpen]);

  // The PR view (W95): opened from a row, a session's link, or a step, its heading takes focus, as the
  // session view's does. Closed with Close, Back or Escape, focus goes back to the PR's row, or the
  // list's heading when the list doesn't show it.
  const focusPrView = useRef<string | undefined>(undefined);
  useEffect(() => {
    const key = focusPrView.current;
    if (key === undefined || key !== prOpen) return;
    focusPrView.current = undefined;
    viewHeading.current?.focus();
  });
  const prRowButtons = useCallback(
    () => [...(app.current?.querySelectorAll<HTMLElement>('.session-list [data-open-pr]') ?? [])].filter((button) => !button.closest('[hidden]')),
    [],
  );
  const prRowButton = (key: string) => prRowButtons().find((button) => button.dataset.openPr === key);
  /** Opens a PR's view in the third column, in place of an open session's, so ?session= follows. */
  const showPr = (key: string, mode: 'push' | 'replace') => {
    prUrl.open(key, mode);
    followSession();
  };
  // From its row, or a session's link: the view's heading takes focus.
  const openPrView = (key: string) => {
    if (key === prOpen) {
      viewHeading.current?.focus();
      return;
    }
    focusPrView.current = key;
    showPr(key, 'push');
  };
  const returnPrFocus = useRef<string | undefined>(undefined);
  const closePr = () => {
    returnPrFocus.current = prOpen;
    prUrl.close();
  };
  // Closes whichever view is open: the session's or the PR's.
  const closeView = () => (openId !== undefined ? opened.close() : prUrl.close());
  const previousPr = useRef(prOpen);
  const previousPrTab = useRef(tab);
  useEffect(() => {
    const was = previousPr.current;
    previousPr.current = prOpen;
    const switched = previousPrTab.current !== tab;
    previousPrTab.current = tab;
    // A session's view that took its place isn't a close either.
    if (was === undefined || prOpen !== undefined || openId !== undefined || switched) return;
    const asked = returnPrFocus.current === was;
    returnPrFocus.current = undefined;
    const instead = focusAfterClose.current;
    focusAfterClose.current = undefined;
    if (instead) {
      instead();
      return;
    }
    const active = document.activeElement;
    if (!asked && active !== null && active !== document.body) return;
    const restore = () => (prRowButton(was) ?? listHeading.current)?.focus();
    if (layout === 'three-columns') {
      restore();
      return;
    }
    const frame = requestAnimationFrame(restore);
    return () => cancelAnimationFrame(frame);
  }, [prOpen, openId, layout, tab]);

  /** The PR row `by` rows from `key`'s in the list as shown, stopping at either end. */
  const prRowFrom = (key: string, by: 1 | -1) => {
    const buttons = prRowButtons();
    const at = buttons.findIndex((button) => button.dataset.openPr === key);
    return at < 0 ? undefined : buttons[at + by];
  };
  // ↑ and ↓ on a PR row: focus moves to the next or previous row; with the PR view open, it shows that PR too.
  const stepFromPrRow = (key: string, by: 1 | -1) => {
    const next = prRowFrom(key, by);
    const id = next?.dataset.openPr;
    if (!next || id === undefined) return;
    next.focus();
    if (prOpen !== undefined) showPr(id, 'replace');
  };
  // ↑ and ↓ in the PR view's header: the next or previous PR, with focus on its heading.
  const stepFromPrView = (by: 1 | -1) => {
    if (prOpen === undefined) return;
    const next = prRowFrom(prOpen, by);
    const id = next?.dataset.openPr;
    if (!next || id === undefined) return;
    next.scrollIntoView?.({ block: 'nearest' });
    focusPrView.current = id;
    showPr(id, 'replace');
  };
  // `j` and `k` in the PR list, as in the session list: from the focused row, or else the open PR, or else the first row.
  const stepPrByKey = (root: HTMLElement, by: 1 | -1): boolean => {
    const buttons = prRowButtons();
    const active = document.activeElement;
    const onRow = active instanceof HTMLElement && buttons.includes(active) ? active.dataset.openPr : undefined;
    const from = onRow ?? prOpen;
    const at = from === undefined ? -1 : buttons.findIndex((button) => button.dataset.openPr === from);
    if (from !== undefined && at < 0) return false;
    const next = from === undefined ? buttons[0] : buttons[at + by];
    const id = next?.dataset.openPr;
    if (!next || id === undefined) return false;
    closeMenus(root);
    if (prOpen === undefined) {
      next.focus();
      return true;
    }
    if (active instanceof Element && active.closest('.session-list') !== null) next.focus();
    else {
      next.scrollIntoView?.({ block: 'nearest' });
      focusPrView.current = id;
    }
    showPr(id, 'replace');
    return true;
  };
  // A session from the PR view's Sessions: its view takes the PR's place, with focus on its heading.
  // No focus gesture (W57): its terminal, if it opens on one, leaves focus where it is.
  const openSessionFromPr = (sessionId: string) => {
    focusView.current = { id: sessionId, on: 'heading' };
    opened.open(sessionId, 'push');
  };
  // Show older for PRs: the same button with its other name keeps focus, or the list's heading once it's gone.
  const focusOlderPrs = useRef(false);
  const toggleOlderPrs = () => {
    setShowOlderPrs((shown) => !shown);
    focusOlderPrs.current = true;
  };
  useEffect(() => {
    if (!focusOlderPrs.current) return;
    focusOlderPrs.current = false;
    (app.current?.querySelector<HTMLElement>('.session-list [data-older-prs-toggle]') ?? listHeading.current)?.focus();
  });

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
    const place = places.get(root) ?? { selection: viewIn('all', root), session: undefined, pr: undefined };
    const { pathname, search, hash } = navigation.location;
    navigation.history.pushState(navigation.history.state, '', `${pathname}${withPr(withSession(withSelection(search, place.selection), place.session), place.pr)}${hash}`);
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
      closeView();
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

  // `s`: stars or unstars the open session, as its view's toggle does, and says so in a toast. Focus
  // stays where it is. Nothing with no session open.
  const starOpen = (): boolean => {
    if (!shownOpen) return false;
    const on = !starred.set.has(shownOpen.sessionId);
    starred.star(shownOpen.sessionId, on);
    toasts.show({ tone: 'success', message: starredText(shownOpen.name, on) });
    return true;
  };

  // Not needed now (W88): from a row's toggle or the view's actions menu. A mark is a toast with Undo,
  // since the session has left Needs you, where it may not be in sight; a later one about the same
  // session replaces it. Taking a mark away from the row needs no toast, as the toggle shows it, and
  // the mark's toast goes, with nothing left to undo; from the menu, which has closed, it's a toast.
  const undoFocus = useRef<string | undefined>(undefined);
  const undoNotNeeded = useRef<(sessionId: string) => void>(() => {});
  // The sessions whose mark's toast, with Undo, may still show: it goes once the mark goes by itself,
  // as what the session needs changes or another tab takes it away, since Undo would have nothing to do.
  const markToasts = useRef(new Set<string>());
  const { dismiss: dismissToast } = toasts;
  useEffect(() => {
    for (const sessionId of markToasts.current) {
      if (marks.has(sessionId)) continue;
      markToasts.current.delete(sessionId);
      dismissToast(notNeededKey(sessionId));
    }
  }, [marks, dismissToast]);
  const setNotNeeded = (session: SessionSummary, on: boolean, from: 'row' | 'menu') => {
    const key = notNeededKey(session.sessionId);
    if (!on) {
      markToasts.current.delete(session.sessionId);
      notNeeded.unmark(session.sessionId);
      if (from === 'menu') toasts.show({ tone: 'success', key, message: putBackText(session.name) });
      else toasts.dismiss(key);
      return;
    }
    // Only one the index says needs you: the toggle and the menu item are on no other.
    if (!needsAttention(session)) return;
    notNeeded.mark(session);
    markToasts.current.add(session.sessionId);
    toasts.show({ tone: 'success', key, message: notNeededText(session.name), action: { label: UNDO_NOT_NEEDED, onAction: () => undoNotNeeded.current(session.sessionId) } });
  };
  // Undo takes its toast away, so focus it had goes to the session's toggle, back in the list and
  // unpressed, or where focusList() puts it when the list doesn't show it or the view covers it.
  // Focus that wasn't in the toast, as after a click that doesn't focus, stays where it is.
  undoNotNeeded.current = (sessionId) => {
    const active = document.activeElement;
    markToasts.current.delete(sessionId);
    notNeeded.unmark(sessionId);
    if (active instanceof Element && active.closest('.toasts') !== null) undoFocus.current = sessionId;
  };
  useEffect(() => {
    const sessionId = undoFocus.current;
    if (sessionId === undefined) return;
    undoFocus.current = undefined;
    const toggle = overlaid
      ? undefined
      : [...(app.current?.querySelectorAll<HTMLElement>('.session-list [data-not-needed-session]') ?? [])].find(
          (button) => button.dataset.notNeededSession === sessionId && !button.closest('[hidden]'),
        );
    if (toggle) toggle.focus();
    else focusList();
  });

  // The latest of each, for the one key listener. Each says whether it did anything.
  const actions = useRef<Record<Shortcut, (root: HTMLElement) => boolean> | undefined>(undefined);
  actions.current = {
    filter: focusFilter,
    'new-session': openNewSession,
    shortcuts: openShortcuts,
    // In the PR list, through its rows; nothing while a session's view is open over it, or a PR's over the session list.
    next: (root) => (prsSelected ? openId === undefined && stepPrByKey(root, 1) : prOpen === undefined && stepByKey(root, 1)),
    previous: (root) => (prsSelected ? openId === undefined && stepPrByKey(root, -1) : prOpen === undefined && stepByKey(root, -1)),
    star: starOpen,
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

  // Group sessions by, in Preferences (W42, W59). The selected group stays when the new mode lists it.
  // One that's listed now and won't be gives way to All sessions in its root tab: the open tab's with a
  // toast, since focus stays on the choice in Preferences; another tab's quietly, for when that tab is back.
  const chooseGroupBy = (next: GroupBy) => {
    if (next === groupBy) return;
    setGroupBy(next);
    if (!snapshot) return;
    const after = groupSessions(windowedGroups ?? snapshot.groups, next).groups;
    const instead = (current: Selection, root: string | undefined): Selection | undefined =>
      'view' in current || findGroup(groups, current) === undefined || findGroup(after, current) !== undefined ? undefined : viewIn('all', root);
    if (tab !== undefined) {
      setPlaces((current) => {
        let changed = false;
        const updated = new Map(current);
        for (const [root, place] of current) {
          const replacement = root === tab ? undefined : instead(place.selection, root);
          if (replacement === undefined) continue;
          updated.set(root, { ...place, selection: replacement });
          changed = true;
        }
        return changed ? updated : current;
      });
    }
    const replacement = instead(selection, tab);
    if (replacement === undefined) return;
    const gone = selectionName(groups, selection, roots);
    const { pathname, search, hash } = navigation.location;
    navigation.history.replaceState(navigation.history.state, '', `${pathname}${withSelection(search, replacement)}${hash}`);
    writeStoredSelection(replacement, storage);
    followSelection();
    toasts.show({ tone: 'info', message: groupGoneText(gone, next) });
  };

  const finishedId = finishedStateId(selection, selectedGroup);
  const setFinished = (id: string, open: boolean) => {
    const next = new Map(finishedOpen);
    next.set(id, open);
    setFinishedOpen(next);
    // Every group of every mode, so a switch of Group sessions by doesn't forget one's state.
    writeGroupState(next, new Set([...everyGroupId(startGroups ?? []), 'view:all', 'view:starred']), storage, FINISHED_STATE_KEY);
  };
  const toggleFinished = () => {
    if (finishedId !== undefined) setFinished(finishedId, !(finishedOpen.get(finishedId) ?? false));
  };

  // Show older and Hide older (W67): one switch for the page. Turning it on opens the selection's
  // Finished section, where they're listed, a group's whose only sessions were older included. The
  // button there keeps focus, as the same button with its other name. From an empty state, whose
  // button goes with it, focus goes to that one, Hide older now; and when Hide older takes the whole
  // selection away, as a group of older sessions alone, to the session list's heading.
  const focusOlder = useRef(false);
  const toggleOlder = () => {
    const next = !showOlder;
    setShowOlder(next);
    const id = finishedStateId(selection, selectedGroup ?? findGroup(groupedAll.groups, selection));
    if (next && id !== undefined && !(finishedOpen.get(id) ?? false)) setFinished(id, true);
    focusOlder.current = true;
  };
  useEffect(() => {
    if (!focusOlder.current) return;
    focusOlder.current = false;
    (app.current?.querySelector<HTMLElement>('.session-list [data-older-toggle]') ?? listHeading.current)?.focus();
  });
  /** An empty state's Show older, while the selection has older ended sessions it would list. */
  const showOlderAction =
    olderCount > 0 && !showOlder ? (
      <Button onClick={() => toggleOlder()}>{olderText(olderCount, false)}</Button>
    ) : undefined;

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
      closeView();
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
  // over no sessions at all, or "Nothing needs you" over Needs you's own "Nothing needs you right now",
  // or over Starred's "No starred sessions".
  const summarised =
    snapshot !== undefined && scope !== undefined && allSessions.length > 0 && !((scope.kind === 'needs-you' || scope.kind === 'starred') && total === 0);
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
          <>
            <Button variant="primary" icon="add" aria-haspopup="dialog" onClick={() => setNewSession(true)}>
              New session
            </Button>
            {/* Every session under the roots is an older ended one (W67). */}
            {showOlderAction}
          </>
        }
      />
    );
  } else if (!scope) {
    // Only Main repo and Every repo it worked in take sessions out of a group the snapshot has.
    const mode = groupBy === 'where-started' ? undefined : groupBy;
    // A group, a root's own included, goes once no session is listed under it, as the chosen grouping has them.
    empty = (
      <EmptyState
        icon="directory"
        title={`No sessions in ${plainText(name)} now`}
        sentence={'view' in selection || mode === undefined || findGroup(startGroups ?? [], selection) === undefined ? GROUP_GONE : groupMovedText(mode)}
        actions={
          <>
            {showAll}
            {/* A group whose only sessions are older ended ones (W67). */}
            {showOlderAction}
          </>
        }
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
  } else if (scope.kind === 'starred' && total === 0) {
    empty = (
      <EmptyState
        icon="star"
        title={NO_STARRED.title}
        sentence={NO_STARRED.sentence}
        actions={
          <>
            {showAll}
            {showOlderAction}
          </>
        }
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
            {/* What the filter finds is all older ended sessions (W67). */}
            {showOlderAction}
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
      starred={starred.set}
      notNeeded={marks}
      prs={repoListPrs}
    />
  );

  // The open session's view, the same element in every layout so it's never remounted. It slides in
  // only when it opens, not when it goes from one session to the next.
  const viewLayout = layout === 'three-columns' ? 'column' : 'overlay';
  // Not when a root tab is switched to: its view was there all along, hidden. Nor when a PR's view takes a session's place, or the other way round (W95).
  const animate = previousOpen.current === undefined && previousPr.current === undefined && previousTab.current === tab;
  // At 600 px and narrower, a view over the PR list goes back to it.
  const backLabel = prsSelected ? 'Back to pull requests' : undefined;
  /**
   * A session's view: the open one, or, `hiddenIn` another root tab, that tab's, kept hidden (W38).
   * Keyed by the session alone, so switching tabs only hides or shows a view, never remounts it.
   */
  const viewOf = (session: SessionSummary, hiddenIn?: string) => (
    <SessionView
      key={session.sessionId}
      session={session}
      placement={{ startedIn: startLabel(startGroups ?? [], session), workedIn: workedInLabels(session, roots) }}
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
      onPromptChange={(open) => {
        prompts.current.set(session.sessionId, open);
      }}
      star={{ starred: starred.set.has(session.sessionId), onStar: starred.star }}
      notNeeded={{ entries: marks, onChange: (changed, on) => setNotNeeded(changed, on, 'menu') }}
      backgroundTab={backgroundTab}
      stepped={hiddenIn === undefined && stepped.current === session.sessionId}
      openedBy={hiddenIn === undefined && opener.current?.sessionId === session.sessionId ? opener.current.gesture : undefined}
      terminalFocus={terminalFocus}
      polledAt={updatedAt}
      backLabel={hiddenIn === undefined ? backLabel : undefined}
      prs={{ linked: linkedPrs.get(session.sessionId) ?? [], onOpen: (pr) => openPrView(prKey(pr)) }}
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
  } else if (prOpen !== undefined && shownPr) {
    sessionView = (
      <PrView
        key={`pr:${prOpen}`}
        pr={shownPr}
        missing={prMissing}
        sessions={sessionsFor(shownPr, everyListed)}
        notNeeded={marks}
        onOpenSession={openSessionFromPr}
        onClose={closePr}
        layout={viewLayout}
        compact={compact}
        headingRef={viewHeading}
        onStep={stepFromPrView}
        animate={animate}
        backLabel={prsSelected ? 'Back to pull requests' : 'Back to sessions'}
      />
    );
  } else if (prOpen !== undefined && prState.kind === 'loading') {
    // A ?pr= from the URL, before the list says what it is.
    sessionView = (
      <WaitingPrView
        key={`pr-waiting:${prOpen}`}
        waiting={prWaiting}
        onClose={closePr}
        layout={viewLayout}
        compact={compact}
        headingRef={viewHeading}
        animate={animate}
        backLabel={prsSelected ? 'Back to pull requests' : 'Back to sessions'}
      />
    );
  } else if (prOpen !== undefined) {
    sessionView = (
      <UnlistedPrView
        key={`pr-unlisted:${prOpen}`}
        prKey={prOpen}
        why={
          prState.kind === 'off' ? (
            <>
              Pull requests are off: pitwall was started with <code>--no-prs</code>, so it doesn't run <code>gh</code>.
            </>
          ) : prState.kind === 'failed' ? (
            "pitwall couldn't list your pull requests, so it can't show this one. The Pull requests list says why."
          ) : undefined
        }
        onClose={closePr}
        layout={viewLayout}
        compact={compact}
        headingRef={viewHeading}
        animate={animate}
        backLabel={prsSelected ? 'Back to pull requests' : 'Back to sessions'}
      />
    );
  } else if (layout === 'three-columns') {
    // With nothing open, the column stays, so the layout doesn't jump.
    sessionView = prsSelected ? (
      <section key="nothing-open" className="session-view-empty" aria-label="Pull request">
        <EmptyState icon="info" title="Select a pull request" sentence="Its checks, review, branch and the sessions that worked on it open here." />
      </section>
    ) : (
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
        onPreferences={() => setPreferencesOpen(true)}
        tabs={
          tab === undefined
            ? undefined
            : { tabs: roots.map((root) => ({ root, attention: tabAttention(groups, root, marks) })), active: tab, onSelect: switchTab, panelId, tabId }
        }
      />

      {/* With root tabs, the columns are the open tab's panel, named by it. */}
      <div className="columns" {...(tab === undefined ? {} : { role: 'tabpanel', id: panelId, 'aria-labelledby': tabId(tab) })}>
        {layout !== 'drawer' && repoList('list')}
        {prsSelected ? (
          <PrList
            alerts={hasAlerts ? alerts : undefined}
            headingRef={listHeading}
            list={prList}
            sessions={everyListed}
            filter={prFilter}
            onFilter={setPrFilter}
            relations={prRelations}
            onRelations={setPrRelations}
            fieldRef={filterField}
            showOlder={showOlderPrs}
            onToggleOlder={toggleOlderPrs}
            collapsed={collapsedRepos}
            onToggleRepo={prRepos.toggle}
            openPrKey={prOpen}
            onOpen={openPrView}
            onStep={stepFromPrRow}
            refresh={prRefresh}
            inert={overlaid}
            onShowAll={() => {
              select(viewIn('all', tab));
              listHeading.current?.focus();
            }}
          />
        ) : (
        <HighlightContext.Provider value={filterNeedle(filters.text)}>
          <SessionList
            alerts={hasAlerts ? alerts : undefined}
            heading={heading}
            headingRef={listHeading}
            headingAction={headingAction}
            summary={summarised ? { total, shown, attention: countAttention(listed.current.map(({ session }) => session), marks) } : undefined}
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
            starred={starred.set}
            onStar={starred.star}
            notNeeded={marks}
            onNotNeeded={(changed, on) => setNotNeeded(changed, on, 'row')}
            inert={overlaid}
            older={olderCount > 0 ? { count: olderCount, shown: showOlder, onToggle: toggleOlder } : undefined}
            prs={linkedPrs}
          />
        </HighlightContext.Provider>
        )}
        {/* The third column from 1,200 px; below that, display: contents, and the view overlays the list. */}
        <div className="session-pane">
          {layout === 'three-columns' && <Divider store={panelWidth} />}
          {paneViews}
        </div>
      </div>

      {layout === 'drawer' && drawerOpen && <RepoDrawer onClose={closeDrawer}>{repoList('drawer')}</RepoDrawer>}

      {newSession && snapshot && (
        <NewSessionDialog
          snapshot={dialogSnapshot ?? snapshot}
          tab={tab}
          onClose={() => setNewSession(false)}
          onStarted={(session) => {
            setNewSession(false);
            started.wait(session);
            toasts.show({ tone: 'success', key: startedKey(session.shortId), message: startedText(session.name) });
          }}
        />
      )}

      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}

      {preferencesOpen && (
        <PreferencesDialog
          onClose={() => setPreferencesOpen(false)}
          groupBy={groupBy}
          onGroupBy={chooseGroupBy}
          backgroundTab={backgroundTab}
          onBackgroundTab={setBackgroundTab}
          terminalFocus={terminalFocus}
          onTerminalFocus={setTerminalFocus}
        />
      )}

      {/* Last, so it's above everything; focus that a dismissed toast had goes to the list's heading, or the view's while it covers the list. */}
      <ToastRegion {...toasts.region} onFocusLost={focusList} />
    </div>
    </ToastContext.Provider>
  );
}
