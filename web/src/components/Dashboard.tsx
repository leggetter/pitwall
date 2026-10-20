import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SessionSummary } from '../../../src/shared/protocol.js';
import type { ConnectionView } from '../connection.js';
import { formatRoots, plainText } from '../format.js';
import {
  browserStorage,
  FINISHED_STATE_KEY,
  readGroupState,
  writeGroupState,
  type GroupState,
  type StorageSource,
} from '../groupState.js';
import { relayAlertText } from '../relay.js';
import { countAttention, filterGroups, filterNeedle, groupId, NO_FILTERS, needYou, noMatchText, sessionCount, type Filters } from '../sessions.js';
import { useOpenWhenListed } from '../spawn.js';
import { FilterControls } from './Filters.js';
import { GroupSection } from './GroupSection.js';
import { Header } from './Header.js';
import { HighlightContext } from './Highlight.js';
import { NewSessionDialog } from './NewSessionDialog.js';
import { SessionView } from './SessionView.js';

/** The current time, refreshed every second, for relative times. */
function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** What the list pane says when the filters hide every session (docs/design-system.md, Empty states). */
function NoMatch({ filters, attention }: { filters: Filters; attention: number }) {
  const { title, sentence } = noMatchText(filters, attention);
  return (
    <div className="placeholder">
      <p className="placeholder-title">{title}</p>
      <p>{sentence}</p>
    </div>
  );
}

export interface DashboardProps {
  view: ConnectionView;
  /** Where the open groups are remembered. Tests pass their own; localStorage otherwise. */
  storage?: StorageSource;
}

export function Dashboard({ view, storage = browserStorage }: DashboardProps) {
  const { state, snapshot, serverError } = view;
  // A heartbeat brings a newer poll than the snapshot, with nothing else changed.
  const updatedAt = view.lastPoll?.generatedAt ?? snapshot?.generatedAt;
  const source = view.lastPoll?.source ?? snapshot?.source;
  const now = useNow();
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  // Groups start collapsed; the ones opened are remembered across reloads.
  const [open, setOpen] = useState<GroupState>(() => readGroupState(storage));
  // Each group's "Finished" sub-list starts collapsed too, and is remembered the same way.
  const [finishedOpen, setFinishedOpen] = useState<GroupState>(() => readGroupState(storage, FINISHED_STATE_KEY));
  const [dismissedError, setDismissedError] = useState<string>();
  // The relay alert dismissed, by its time and count: a later one shows again.
  const [dismissedAlert, setDismissedAlert] = useState<string>();
  // The session whose view is open, as it was when opened. While it's listed, the live summary is shown.
  const [opened, setOpened] = useState<SessionSummary>();

  const groups = snapshot?.groups ?? [];
  const allSessions = useMemo(() => groups.flatMap((group) => group.sessions), [groups]);
  const attention = countAttention(allSessions);
  const visible = useMemo(() => filterGroups(groups, filters), [groups, filters]);
  const roots = snapshot ? formatRoots(snapshot.roots) : '';
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

  const toggle = (id: string) => {
    const next = new Map(open);
    next.set(id, !(open.get(id) ?? false));
    setOpen(next);
    writeGroupState(next, new Set(groups.map(groupId)), storage);
  };

  const toggleFinished = (id: string) => {
    const next = new Map(finishedOpen);
    next.set(id, !(finishedOpen.get(id) ?? false));
    setFinishedOpen(next);
    writeGroupState(next, new Set(groups.map(groupId)), storage, FINISHED_STATE_KEY);
  };

  const showError = serverError !== undefined && serverError !== dismissedError;
  const relayAlert = snapshot?.relayAlert;
  const relayAlertKey = relayAlert ? `${relayAlert.at}#${relayAlert.count}` : undefined;
  const alertText = relayAlert && relayAlertKey !== dismissedAlert ? relayAlertText(relayAlert) : undefined;

  return (
    <div className="app">
      <Header
        state={state}
        roots={snapshot?.roots}
        updatedAt={snapshot ? updatedAt : undefined}
        now={now}
        onNewSession={snapshot ? () => setNewSession(true) : undefined}
      />

      {snapshot && allSessions.length > 0 && (
        // For now, today's controls in a row under the header: the filters, the "Needs attention only"
        // checkbox and the summary. The three-column layout (W21) gives them their places.
        <div className="controls">
          <FilterControls filters={filters} onChange={setFilters}>
            <label className="toggle">
              <input
                type="checkbox"
                checked={filters.attentionOnly}
                onChange={(event) => setFilters((current) => ({ ...current, attentionOnly: event.target.checked }))}
              />
              Needs attention only
            </label>
          </FilterControls>
          <p className="summary">
            {sessionCount(allSessions.length)}
            {attention > 0 ? (
              <>
                {' · '}
                <strong className="summary-attention">{needYou(attention)}</strong>
              </>
            ) : (
              ' · nothing needs you'
            )}
          </p>
        </div>
      )}

      <div className="panes">
        <main className="list-pane">
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

          {!snapshot ? (
            <p className="placeholder">{state === 'reconnecting' ? 'Reconnecting to pitwall…' : 'Connecting to pitwall…'}</p>
          ) : allSessions.length === 0 ? (
            <p className="placeholder">No Claude Code sessions under {plainText(roots)}</p>
          ) : visible.length === 0 ? (
            <NoMatch filters={filters} attention={attention} />
          ) : (
            <HighlightContext.Provider value={filterNeedle(filters.text)}>
              {visible.map(({ group, sessions }) => {
                const id = groupId(group);
                return (
                  <GroupSection
                    key={id}
                    group={group}
                    sessions={sessions}
                    collapsed={!(open.get(id) ?? false)}
                    onToggle={() => toggle(id)}
                    finishedCollapsed={!(finishedOpen.get(id) ?? false)}
                    onToggleFinished={() => toggleFinished(id)}
                    showRoot={snapshot.roots.length > 1}
                    now={now}
                    onOpen={openSession}
                    openSessionId={shownOpen?.sessionId}
                  />
                );
              })}
            </HighlightContext.Provider>
          )}
        </main>
      </div>

      {shownOpen && (
        <SessionView
          key={shownOpen.sessionId}
          session={shownOpen}
          listed={listedOpen !== undefined}
          now={now}
          onClose={closeSession}
        />
      )}

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
