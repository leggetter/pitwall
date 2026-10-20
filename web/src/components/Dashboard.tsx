// The app (docs/design-system.md, 3): the header, then three columns, the repo list, the session list
// and the session view. The page doesn't scroll; each column does. Below 1,200 px the session view
// overlays the session list, and below 900 px the repo list is a drawer opened from the header.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SessionSummary } from '../../../src/shared/protocol.js';
import type { ConnectionView } from '../connection.js';
import { formatRoots, plainText } from '../format.js';
import { browserStorage, FINISHED_STATE_KEY, readGroupState, writeGroupState, type GroupState, type StorageSource } from '../groupState.js';
import { useLayout } from '../layout.js';
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
import { useOpenWhenListed } from '../spawn.js';
import { FilterControls } from './Filters.js';
import { Header } from './Header.js';
import { HighlightContext } from './Highlight.js';
import { NewSessionDialog } from './NewSessionDialog.js';
import { RepoDrawer } from './RepoDrawer.js';
import { RepoList } from './RepoList.js';
import { SessionList, type SessionListHeading } from './SessionList.js';
import { SessionView } from './SessionView.js';
import { SortSelect } from './SortSelect.js';

/** The current time, refreshed every second, for relative times. */
function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** A state in place of the session list's rows. Today's look, until W28 restyles the empty states. */
function Placeholder({ title, sentence, children }: { title: string; sentence?: string; children?: ReactNode }) {
  return (
    <div className="placeholder">
      <p className="placeholder-title">{title}</p>
      {sentence && <p>{sentence}</p>}
      {children && <p className="placeholder-actions">{children}</p>}
    </div>
  );
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
  const now = useNow();
  const app = useRef<HTMLDivElement>(null);
  const layout = useLayout(app);
  const [selection, choose] = useSelection(snapshot, { navigation, storage });
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  // Urgency, Recent or Name, for every selection.
  const [sort, setSort] = useSort(storage);
  // Each selection's Finished section starts collapsed, and is remembered.
  const [finishedOpen, setFinishedOpen] = useState<GroupState>(() => readGroupState(storage, FINISHED_STATE_KEY));
  const [dismissedError, setDismissedError] = useState<string>();
  // The relay alert dismissed, by its time and count: a later one shows again.
  const [dismissedAlert, setDismissedAlert] = useState<string>();
  // The session whose view is open, as it was when opened. While it's listed, the live summary is shown.
  const [opened, setOpened] = useState<SessionSummary>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const reposButton = useRef<HTMLButtonElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);

  const groups = snapshot?.groups ?? [];
  const roots = snapshot?.roots ?? [];
  const allSessions = useMemo(() => groups.flatMap((group) => group.sessions), [groups]);
  const attention = countAttention(allSessions);
  const selectedGroup = findGroup(groups, selection);
  const scope = scopeFor(groups, selection);
  const listed = useMemo(() => (scope ? listScope(groups, scope, sort) : { current: [], finished: [] }), [groups, scope?.kind, selectedGroup, sort]);
  const current = useMemo(() => filterListed(listed.current, filters), [listed, filters]);
  const finished = useMemo(() => filterListed(listed.finished, filters), [listed, filters]);
  const listedOpen = opened ? allSessions.find((session) => session.sessionId === opened.sessionId) : undefined;
  const shownOpen = listedOpen ?? opened;
  // The New session dialog, and the session it started, opened once it's listed.
  const [newSession, setNewSession] = useState(false);
  const started = useOpenWhenListed(allSessions, setOpened);

  const openSession = useCallback(
    (sessionId: string) => {
      const session = allSessions.find((candidate) => candidate.sessionId === sessionId);
      if (session) setOpened(session);
    },
    [allSessions],
  );

  const closeSession = useCallback(() => {
    const id = opened?.sessionId;
    setOpened(undefined);
    // Back to the row it was opened from, when that's still on screen.
    for (const button of document.querySelectorAll<HTMLElement>('[data-open-session]')) {
      if (button.dataset.openSession === id) button.focus();
    }
  }, [opened]);

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
    reposButton.current?.focus();
  };

  // Choosing in the drawer closes it, and focus goes to the session list's heading (6.1), once the drawer has gone.
  const focusHeading = useRef(false);
  useEffect(() => {
    if (drawerOpen || !focusHeading.current) return;
    focusHeading.current = false;
    listHeading.current?.focus();
  }, [drawerOpen]);

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
  const relayAlertKey = relayAlert ? `${relayAlert.at}#${relayAlert.count}` : undefined;
  const alertText = relayAlert && relayAlertKey !== dismissedAlert ? relayAlertText(relayAlert) : undefined;
  const alerts = (
    <>
      {snapshot && source && !source.ok && (
        <div className="banner warning" role="alert">
          <code>claude agents --json --all</code> failed on the latest poll: {plainText(source.error)}
        </div>
      )}
      {relayAlert && alertText && (
        <div className={relayAlert.blocked ? 'banner warning relay-alert' : 'banner error relay-alert'} role="alert">
          <span>
            {alertText.summary} {alertText.count} Latest: {plainText(relayAlert.detail)}
          </span>
          <button type="button" className="link-button" onClick={() => setDismissedAlert(relayAlertKey)}>
            Dismiss
          </button>
        </div>
      )}
      {showError && (
        <div className="banner error" role="alert">
          <span>{plainText(serverError)}</span>
          <button type="button" className="link-button" onClick={() => setDismissedError(serverError)}>
            Dismiss
          </button>
        </div>
      )}
      {started.waiting && (
        <div className="banner muted" role="status">
          <span>Started {plainText(started.waiting.name)}. Its view opens when it shows up in the list.</span>
          <button type="button" className="link-button" onClick={started.dismiss}>
            Dismiss
          </button>
        </div>
      )}
      {snapshot && state === 'reconnecting' && (
        <div className="banner muted">Lost the connection to pitwall. Reconnecting; this list may be out of date.</div>
      )}
    </>
  );
  const hasAlerts = (snapshot && source && !source.ok) || (relayAlert && alertText) || showError || started.waiting || (snapshot && state === 'reconnecting');

  const name = selectionName(groups, selection);
  const heading: SessionListHeading =
    'view' in selection
      ? { label: name }
      : { label: name, kind: selectedGroup?.kind, root: roots.length > 1 ? (selectedGroup?.root ?? selection.root) : undefined };
  const total = listed.current.length + listed.finished.length;
  const shown = current.length + finished.length;
  const showAll = (
    <button type="button" className="button" onClick={() => select(ALL_SESSIONS)}>
      Show all sessions
    </button>
  );

  // What takes the rows' place, if anything.
  let empty: ReactNode;
  if (!snapshot) {
    empty = <p className="placeholder">{state === 'reconnecting' ? 'Reconnecting to pitwall…' : 'Connecting to pitwall…'}</p>;
  } else if (allSessions.length === 0) {
    empty = <p className="placeholder">No Claude Code sessions under {plainText(formatRoots(snapshot.roots))}</p>;
  } else if (!scope) {
    empty = (
      <Placeholder title={`No sessions in ${plainText(name)} now`} sentence="Its sessions are no longer listed under these roots.">
        {showAll}
      </Placeholder>
    );
  } else if (scope.kind === 'needs-you' && total === 0) {
    empty = (
      <Placeholder title="Nothing needs you right now" sentence="Sessions that are waiting for you, or asked you something, show here.">
        {showAll}
      </Placeholder>
    );
  } else if (shown === 0 && total > 0) {
    const { title, sentence } = noMatchText(filters, plainText(name));
    empty = (
      <Placeholder title={title} sentence={sentence}>
        <button type="button" className="button" onClick={() => setFilters(NO_FILTERS)}>
          Clear filters
        </button>
        {scope.kind === 'group' && filters.text.trim() !== '' && (
          // Keeps the text: the same search, across every group.
          <button type="button" className="button" onClick={() => select(ALL_SESSIONS)}>
            Search all sessions
          </button>
        )}
      </Placeholder>
    );
  }

  const repoList = (from: 'list' | 'drawer') => (
    <RepoList
      groups={snapshot?.groups}
      roots={roots}
      selection={selection}
      onSelect={(next) => select(next, from)}
      autoFocus={from === 'drawer'}
    />
  );

  const sessionView = (column: boolean) =>
    shownOpen && (
      <SessionView
        key={shownOpen.sessionId}
        session={shownOpen}
        listed={listedOpen !== undefined}
        now={now}
        onClose={closeSession}
        layout={column ? 'column' : 'overlay'}
      />
    );

  return (
    <div className="app" ref={app} data-layout={layout}>
      <Header
        state={state}
        roots={snapshot?.roots}
        updatedAt={snapshot ? updatedAt : undefined}
        now={now}
        onNewSession={snapshot ? () => setNewSession(true) : undefined}
        onRepos={layout === 'drawer' ? () => setDrawerOpen(true) : undefined}
        reposOpen={drawerOpen}
        reposRef={reposButton}
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
                <FilterControls filters={filters} onChange={setFilters}>
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
            now={now}
            onOpen={openSession}
            openSessionId={shownOpen?.sessionId}
          />
        </HighlightContext.Provider>
        {layout === 'three-columns' &&
          (sessionView(true) || (
            <section className="session-view-empty" aria-label="Session">
              <Placeholder title="Select a session" sentence="Its conversation, terminal and actions open here." />
            </section>
          ))}
      </div>

      {layout !== 'three-columns' && sessionView(false)}

      {layout === 'drawer' && drawerOpen && <RepoDrawer onClose={closeDrawer}>{repoList('drawer')}</RepoDrawer>}

      {newSession && snapshot && (
        <NewSessionDialog
          snapshot={snapshot}
          onClose={() => setNewSession(false)}
          onStarted={(session) => {
            setNewSession(false);
            started.wait(session);
          }}
        />
      )}
    </div>
  );
}
