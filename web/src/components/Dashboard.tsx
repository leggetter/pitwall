import { useEffect, useMemo, useState } from 'react';
import type { ConnectionState, ConnectionView } from '../connection.js';
import { formatRoots, plainText, updatedAgo } from '../format.js';
import { countAttention, filterGroups, groupId, needYou, type Filters } from '../sessions.js';
import { GroupSection } from './GroupSection.js';

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

export function Dashboard({ view }: { view: ConnectionView }) {
  const { state, snapshot, serverError } = view;
  const now = useNow();
  const [filters, setFilters] = useState<Filters>({ text: '', attentionOnly: false });
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [dismissedError, setDismissedError] = useState<string>();

  const groups = snapshot?.groups ?? [];
  const allSessions = useMemo(() => groups.flatMap((group) => group.sessions), [groups]);
  const attention = countAttention(allSessions);
  const visible = useMemo(() => filterGroups(groups, filters), [groups, filters]);
  const roots = snapshot ? formatRoots(snapshot.roots) : '';

  useEffect(() => {
    document.title = attention > 0 ? `(${attention}) pitwall` : 'pitwall';
    return () => {
      document.title = 'pitwall';
    };
  }, [attention]);

  const toggle = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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
            {snapshot && (
              <time className="updated" dateTime={snapshot.generatedAt}>
                {updatedAgo(snapshot.generatedAt, now)}
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
                placeholder="Filter by session, repo or directory"
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

      {snapshot && !snapshot.source.ok && (
        <div className="banner warning" role="alert">
          <code>claude agents --json</code> failed on the latest poll: {plainText(snapshot.source.error)}
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
                collapsed={collapsed.has(id)}
                onToggle={() => toggle(id)}
                showRoot={snapshot.roots.length > 1}
                now={now}
              />
            );
          })
        )}
      </main>
    </div>
  );
}
