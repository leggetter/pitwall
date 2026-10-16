import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SessionSummary } from '../../../src/shared/protocol.js';
import type { ConnectionState, ConnectionView } from '../connection.js';
import { formatRoots, plainText, updatedAgo } from '../format.js';
import { browserStorage, readGroupState, writeGroupState, type GroupState, type StorageSource } from '../groupState.js';
import { countAttention, filterGroups, groupId, needYou, type Filters } from '../sessions.js';
import { GroupSection } from './GroupSection.js';
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

const STATE_LABELS: Record<ConnectionState, string> = {
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
  unauthorized: 'Token rejected',
};

function ConnectionBadge({ state }: { state: ConnectionState }) {
  return (
    <span className={`connection state-${state}`} role="status">
      <span className="dot" aria-hidden="true" />
      {STATE_LABELS[state]}
    </span>
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
  const [filters, setFilters] = useState<Filters>({ text: '', attentionOnly: false });
  // Groups start collapsed; the ones opened are remembered across reloads.
  const [open, setOpen] = useState<GroupState>(() => readGroupState(storage));
  const [dismissedError, setDismissedError] = useState<string>();
  // The session whose view is open, as it was when opened. While it's listed, the live summary is shown.
  const [opened, setOpened] = useState<SessionSummary>();

  const groups = snapshot?.groups ?? [];
  const allSessions = useMemo(() => groups.flatMap((group) => group.sessions), [groups]);
  const attention = countAttention(allSessions);
  const visible = useMemo(() => filterGroups(groups, filters), [groups, filters]);
  const roots = snapshot ? formatRoots(snapshot.roots) : '';
  const listedOpen = opened ? allSessions.find((session) => session.sessionId === opened.sessionId) : undefined;
  const shownOpen = listedOpen ?? opened;

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

  const showError = serverError !== undefined && serverError !== dismissedError;

  return (
    <div className="app">
      <header className="masthead">
        <div className="masthead-row">
          <h1 className="brand">pitwall</h1>
          {snapshot && (
            <p className="roots" title={snapshot.roots.join(', ')}>
              {plainText(roots)}
            </p>
          )}
          <div className="masthead-status">
            <ConnectionBadge state={state} />
            {snapshot && updatedAt && (
              <time className="updated" dateTime={updatedAt}>
                {updatedAgo(updatedAt, now)}
              </time>
            )}
          </div>
        </div>

        {snapshot && allSessions.length > 0 && (
          <div className="masthead-row controls">
            <form className="filters" role="search" onSubmit={(event) => event.preventDefault()}>
              <label className="visually-hidden" htmlFor="filter">
                Filter sessions
              </label>
              <input
                id="filter"
                type="search"
                className="filter-input"
                placeholder="Filter by session, title, repo or directory"
                autoComplete="off"
                spellCheck={false}
                value={filters.text}
                onChange={(event) => setFilters((current) => ({ ...current, text: event.target.value }))}
              />
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={filters.attentionOnly}
                  onChange={(event) => setFilters((current) => ({ ...current, attentionOnly: event.target.checked }))}
                />
                Needs attention only
              </label>
            </form>
            <p className="summary">
              {allSessions.length} {allSessions.length === 1 ? 'session' : 'sessions'}
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
      </header>

      {snapshot && source && !source.ok && (
        <div className="banner warning" role="alert">
          <code>claude agents --json</code> failed on the latest poll: {plainText(source.error)}
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
      {snapshot && state === 'reconnecting' && (
        <div className="banner muted">Lost the connection to pitwall. Reconnecting; this list may be out of date.</div>
      )}

      <main className="content">
        {!snapshot ? (
          <p className="placeholder">{state === 'reconnecting' ? 'Reconnecting to pitwall…' : 'Connecting to pitwall…'}</p>
        ) : allSessions.length === 0 ? (
          <p className="placeholder">No Claude Code sessions under {plainText(roots)}</p>
        ) : visible.length === 0 ? (
          <p className="placeholder">
            {filters.attentionOnly && attention === 0 && filters.text.trim() === ''
              ? 'Nothing needs you right now.'
              : 'No sessions match the filter.'}
          </p>
        ) : (
          visible.map(({ group, sessions }) => {
            const id = groupId(group);
            return (
              <GroupSection
                key={id}
                group={group}
                sessions={sessions}
                collapsed={!(open.get(id) ?? false)}
                onToggle={() => toggle(id)}
                showRoot={snapshot.roots.length > 1}
                now={now}
                onOpen={openSession}
                openSessionId={shownOpen?.sessionId}
              />
            );
          })
        )}
      </main>

      {shownOpen && (
        <SessionView
          key={shownOpen.sessionId}
          session={shownOpen}
          listed={listedOpen !== undefined}
          now={now}
          onClose={closeSession}
        />
      )}
    </div>
  );
}
