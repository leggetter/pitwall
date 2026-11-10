// The Usage view (W158, docs/design-system.md, 4: Usage): from the header's Usage button, a dialog
// over the page, as Preferences is, with `?usage` in the URL (usage.ts). What's using the plan's week:
// tokens by day, or by hour for 24 hours, by repo and by session, ranked by stand-in cost, by model,
// and main sessions against sub-agents.
//
// - The window is a row of tabs, This week first, which is the plan's week from its reset when
//   pitwall can read it (W157), else the last 7 days. The plan's percentage and reset lead the
//   summary; W159's pace goes beside them.
// - Cache writes and cache reads are columns of their own, never summed with input and output into
//   one total: 97.7% of tokens are cache reads (W131). Cost is labelled as an estimate everywhere.
// - Every figure is in a table. The by-day table's cost column carries a bar, one series in the
//   accent, so there's no chart to read apart from its numbers.
// - What can't be read says so: the plan's week "unavailable" with why, a failed read as an alert
//   with the figures already shown kept.

import { useContext, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { SessionSummary, UsageBucket, UsageTokens, UsageView, UsageWindowKey } from '../../../src/shared/protocol.js';
import { USAGE_WINDOWS } from '../../../src/shared/protocol.js';
import { ApiContext } from '../api.js';
import { plainText } from '../format.js';
import { modelText } from '../modelEffort.js';
import { moveTabFocus } from '../tabs.js';
import { bucketText, costText, planReasonText, resetText, tokenText, USAGE_LABEL, useUsage, WINDOW_LABELS, windowText } from '../usage.js';
import { Alert } from './Alert.js';
import { Button } from './Button.js';
import { CodeText } from './CodeText.js';
import { Dialog } from './Dialog.js';
import { Spinner } from './Spinner.js';
import { Timestamp } from './Timestamp.js';
import './Usage.css';

export interface UsageDialogProps {
  onClose: () => void;
  /** The sessions listed now, to name a session row by its name rather than its id. */
  sessions: readonly SessionSummary[];
}

/** The four kinds of token, each its own column, then the cost. */
const COLUMNS = [
  ['input', 'Input'],
  ['cacheWrite', 'Cache writes'],
  ['cacheRead', 'Cache reads'],
  ['output', 'Output'],
] as const;

export function UsageDialog({ onClose, sessions }: UsageDialogProps) {
  const api = useContext(ApiContext);
  const [windowKey, setWindowKey] = useState<UsageWindowKey>('week');
  const { state, refresh } = useUsage(api, windowKey);
  // Only ever the chosen window's figures (useUsage()).
  const view = state.view;
  const ids = { panel: useId(), tab: useId() };
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);

  return (
    <Dialog
      title={USAGE_LABEL}
      size="lg"
      className="usage-dialog"
      subtitle="Tokens from your sessions' transcripts. Costs are estimates at API list prices."
      onClose={onClose}
      footerMeta={
        view && (
          <span>
            Read <Timestamp at={view.scan.at} format="relative" /> from {view.scan.files} {view.scan.files === 1 ? 'transcript' : 'transcripts'}
            {view.scan.unreadable > 0 ? `, ${view.scan.unreadable} unreadable` : ''}.
          </span>
        )
      }
      actions={
        <Button icon="retry" busy={state.kind === 'loading' && view !== undefined} onClick={refresh}>
          {state.kind === 'loading' && view !== undefined ? 'Refreshing…' : 'Refresh'}
        </Button>
      }
    >
      <div className="usage-tabs" role="tablist" aria-label="Window">
        {USAGE_WINDOWS.map((key, index) => (
          <button
            key={key}
            ref={(element) => {
              tabs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`${ids.tab}-${key}`}
            className="session-tab"
            aria-selected={windowKey === key}
            aria-controls={ids.panel}
            tabIndex={windowKey === key ? 0 : -1}
            onClick={() => setWindowKey(key)}
            onKeyDown={(event) => moveTabFocus(event, tabs.current)}
          >
            {WINDOW_LABELS[key]}
          </button>
        ))}
      </div>
      <div className="usage-panel" role="tabpanel" id={ids.panel} aria-labelledby={`${ids.tab}-${windowKey}`} aria-busy={state.kind === 'loading'}>
        {state.kind === 'failed' && (
          <Alert tone="danger" role="alert">
            {state.message}
          </Alert>
        )}
        {view === undefined && state.kind === 'loading' && (
          <p className="usage-loading" role="status">
            <Spinner /> Loading {WINDOW_LABELS[windowKey].toLowerCase()}… The first read of your transcripts can take a few seconds.
          </p>
        )}
        {view && <UsageBody view={view} sessions={sessions} />}
      </div>
    </Dialog>
  );
}

function UsageBody({ view, sessions }: { view: UsageView; sessions: readonly SessionSummary[] }) {
  const names = new Map(sessions.map((session) => [session.sessionId, session.name]));
  const byDay = view.window.bucket === 'day';
  const most = Math.max(0, ...view.buckets.map((bucket) => bucket.cost));
  const historyNote = view.history && (
    <p className="field-hint usage-note">
      Also {costText(view.history.cost)} on {view.history.days} {view.history.days === 1 ? 'day' : 'days'} whose transcripts Claude Code has deleted: in the totals, by day and by model, but in no row
      here.
    </p>
  );
  // Nothing in the window, and no kept day for it: one line, not tables of zeros.
  if (view.totals.calls === 0 && view.history === undefined) {
    return (
      <>
        <p className="usage-window">{windowText(view)}</p>
        <div className="usage-summary">
          <PlanFigure view={view} />
        </div>
        <p className="usage-empty">No calls in this window.</p>
      </>
    );
  }
  return (
    <>
      <p className="usage-window">{windowText(view)}</p>
      <div className="usage-summary">
        <PlanFigure view={view} />
        <dl className="usage-stats">
          <Stat label="Est. cost" value={costText(view.totals.cost)} lead />
          {COLUMNS.map(([field, label]) => (
            <Stat key={field} label={label} value={tokenText(view.totals[field])} />
          ))}
          <Stat label="Calls" value={tokenText(view.totals.calls)} />
        </dl>
      </div>
      <p className="field-hint usage-note">Est. cost: {view.costLabel}.</p>

      <UsageTable
        title={byDay ? 'By day' : 'By hour'}
        first={byDay ? 'Day' : 'Hour'}
        rows={view.buckets.map((bucket) => ({
          key: bucket.start,
          name: <BucketName bucket={bucket} byDay={byDay} />,
          tokens: bucket,
          bar: most > 0 ? bucket.cost / most : 0,
        }))}
      />

      <UsageTable
        title="Main sessions and sub-agents"
        first="Calls by"
        rows={[
          { key: 'main', name: `Main sessions (${view.split.main.sessions})`, tokens: view.split.main },
          { key: 'subagent', name: `Sub-agents (${view.split.subagent.runs} ${view.split.subagent.runs === 1 ? 'run' : 'runs'})`, tokens: view.split.subagent },
        ]}
      />

      <UsageTable
        title="By repo"
        first="Repo"
        extra={{ label: 'Sessions', numeric: true }}
        rows={view.byRepo.rows.map((row) => ({ key: row.repo, name: <span className="usage-path">{plainText(row.repo)}</span>, tokens: row, extra: String(row.sessions) }))}
        rest={view.byRepo.rest && { label: `${view.byRepo.rest.count} more ${view.byRepo.rest.count === 1 ? 'repo' : 'repos'}`, tokens: view.byRepo.rest }}
        empty="No calls in this window."
        note={historyNote}
      />

      <UsageTable
        title="By session"
        first="Session"
        extra={{ label: 'Details', numeric: false }}
        rows={view.bySession.rows.map((row) => {
          const name = names.get(row.sessionId);
          return {
            key: row.sessionId,
            // The row's header is its name alone; its id, repo, model and sub-agents are a cell of their own.
            name: <span className="usage-session-name">{name !== undefined ? plainText(name) : row.kind === 'pitwall' ? "pitwall's own" : 'Not listed'}</span>,
            extra: (
              <span className="usage-session-meta">
                <code>{row.sessionId.slice(0, 8)}</code> · <span className="usage-path">{plainText(row.repo)}</span>
                {row.model !== '' && ` · ${modelText(row.model)}`}
                {row.subagentRuns > 0 && ` · sub-agents ${costText(row.subagentCost)}`}
              </span>
            ),
            tokens: row,
          };
        })}
        rest={view.bySession.rest && { label: `${view.bySession.rest.count} more ${view.bySession.rest.count === 1 ? 'session' : 'sessions'}`, tokens: view.bySession.rest }}
        empty="No calls in this window."
        note={historyNote}
      />

      <UsageTable title="By model" first="Model" rows={view.byModel.map((row) => ({ key: row.model, name: modelText(row.model), tokens: row }))} empty="No calls in this window." />
    </>
  );
}

function BucketName({ bucket, byDay }: { bucket: UsageBucket; byDay: boolean }) {
  return (
    <>
      {bucketText(bucket.start, byDay ? 'day' : 'hour')}
      {bucket.history && <span className="usage-kept"> (kept total)</span>}
    </>
  );
}

/** The plan's week, from `/usage` (W157), or why it's unavailable. W159's pace goes beside it. */
function PlanFigure({ view }: { view: UsageView }) {
  const plan = view.plan;
  if (plan.status === 'unavailable' || plan.sevenDay === null) {
    return (
      <div className="usage-plan">
        <p className="usage-plan-label">Plan's week</p>
        <p className="usage-plan-value usage-plan-off">Unavailable</p>
        <p className="field-hint">
          <CodeText text={plan.status === 'unavailable' ? `${planReasonText(plan.reason)}.` : "Claude Code's `/usage` had no weekly limit for your plan."} />
        </p>
      </div>
    );
  }
  const week = plan.sevenDay;
  return (
    <div className="usage-plan">
      <p className="usage-plan-label">Plan's week</p>
      <p className="usage-plan-value">{Math.round(week.usedPercentage)}% used</p>
      {week.resetsAt !== null && <p className="field-hint">Resets {resetText(week.resetsAt)}</p>}
    </div>
  );
}

function Stat({ label, value, lead = false }: { label: string; value: string; lead?: boolean }) {
  return (
    <div className={lead ? 'usage-stat lead' : 'usage-stat'}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

interface TableRow {
  key: string;
  name: ReactNode;
  tokens: UsageTokens;
  /** The cost bar's length, 0 to 1, for the by-day table. */
  bar?: number;
  /** The extra column's cell, where the table has one. */
  extra?: ReactNode;
}

/** Whether the element's content is wider than its box, kept up to date as either changes size. */
function useScrolls(ref: RefObject<HTMLElement | null>, shown: boolean): boolean {
  const [scrolls, setScrolls] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const measure = () => setScrolls(element.scrollWidth > element.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const table = element.firstElementChild;
    if (table !== null) observer.observe(table);
    return () => observer.disconnect();
  }, [ref, shown]);
  return scrolls;
}

function UsageTable({
  title,
  first,
  rows,
  rest,
  extra,
  empty,
  note,
}: {
  title: string;
  first: string;
  rows: TableRow[];
  rest?: { label: string; tokens: UsageTokens } | undefined;
  /** A column after the row's name: Sessions, or a session's details. */
  extra?: { label: string; numeric: boolean };
  empty?: string;
  note?: ReactNode;
}) {
  const id = useId();
  const bars = rows.some((row) => row.bar !== undefined);
  const wrap = useRef<HTMLDivElement>(null);
  const scrolls = useScrolls(wrap, rows.length > 0 || empty === undefined);
  const extraClass = extra?.numeric ? 'num' : 'usage-detail';
  return (
    <section className="usage-section">
      <h3 id={id}>{title}</h3>
      {rows.length === 0 && empty !== undefined ? (
        <p className="field-hint">{empty}</p>
      ) : (
        // A region with a name, which takes focus only while the table is wider than its box, so the
        // keyboard can scroll it sideways then, and Tab doesn't stop on it otherwise.
        <div ref={wrap} className="usage-table-wrap" role="region" aria-labelledby={id} tabIndex={scrolls ? 0 : undefined}>
          <table className={bars ? 'usage-table has-bars' : 'usage-table'}>
            <caption className="visually-hidden">{title}</caption>
            <thead>
              <tr>
                <th scope="col">{first}</th>
                {extra && (
                  <th scope="col" className={extraClass}>
                    {extra.label}
                  </th>
                )}
                <th scope="col" className="num">
                  Est. cost
                </th>
                {COLUMNS.map(([field, label]) => (
                  <th key={field} scope="col" className="num">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <th scope="row">{row.name}</th>
                  {extra && <td className={extraClass}>{row.extra}</td>}
                  <td className="num cost">
                    {row.bar === undefined ? (
                      costText(row.tokens.cost)
                    ) : (
                      // The bar and the figure in a flex line of their own, so the cell stays a table cell.
                      <span className="usage-cost">
                        <span className="usage-bar" aria-hidden="true">
                          <span style={{ width: `${Math.round(row.bar * 100)}%` }} />
                        </span>
                        <span className="usage-figure">{costText(row.tokens.cost)}</span>
                      </span>
                    )}
                  </td>
                  {COLUMNS.map(([field]) => (
                    <td key={field} className="num">
                      {tokenText(row.tokens[field])}
                    </td>
                  ))}
                </tr>
              ))}
              {rest && (
                <tr className="usage-rest">
                  <th scope="row">{rest.label}</th>
                  {extra && <td className={extraClass} />}
                  <td className="num cost">{costText(rest.tokens.cost)}</td>
                  {COLUMNS.map(([field]) => (
                    <td key={field} className="num">
                      {tokenText(rest.tokens[field])}
                    </td>
                  ))}
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {note}
    </section>
  );
}
