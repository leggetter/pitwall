// Leads and workers in the session list (W218, leads.ts; docs/design-system.md, 4: Leads and workers):
// a lead's row, then its workers' rows indented under it with a guide line, in a list of their own that
// the caret on the lead's row opens and closes; and the one-line pointer a worker leaves in its own
// repo group when its lead is listed under another. Rows are SessionRow's, so a worker's star, snooze,
// flag, ↑ and ↓, and its click all work as on any row.
//
// The workers' list is a sibling item after the lead's row, not inside it, so a click on a worker's row
// opens that worker, never the lead as well.

import { useCallback, useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { PullRequestSummary, SessionSummary } from '../../../src/shared/protocol.js';
import { plainText } from '../format.js';
import { closedWorkersText, pointerText, readClosedLeads, toggleClosed, workerCount, writeClosedLeads, type ArrangedListed } from '../leads.js';
import { browserStorage, type StorageSource } from '../groupState.js';
import { Highlight } from './Highlight.js';
import { SESSION_VIEW_ID, SessionRow } from './SessionRow.js';

/** Which leads' workers are closed, remembered in the browser (leads.ts, pitwall.leads.v1). Open by default. */
export interface LeadsOpen {
  isOpen: (leadId: string) => boolean;
  toggle: (leadId: string, open: boolean) => void;
  /** A worker's "reported 10:42" (W218 piece 2): opens its view on the Conversation tab. No link without it. */
  onReported?: ((sessionId: string) => void) | undefined;
}

export function useLeadsOpen(storage: StorageSource = browserStorage): LeadsOpen {
  const [closed, setClosed] = useState(() => readClosedLeads(storage));
  const isOpen = useCallback((leadId: string) => !closed.includes(leadId), [closed]);
  const toggle = useCallback(
    (leadId: string, open: boolean) => {
      setClosed((current) => {
        const next = toggleClosed(current, leadId, open);
        writeClosedLeads(storage, next);
        return next;
      });
    },
    [storage],
  );
  return { isOpen, toggle };
}

/** What every row in the list shares, as SessionList passes it to SessionRow. */
export interface RowShared {
  showGroup: boolean;
  onOpen?: ((sessionId: string) => void) | undefined;
  onStep?: ((sessionId: string, by: 1 | -1) => void) | undefined;
  openSessionId?: string | undefined;
  starred?: ReadonlySet<string> | undefined;
  onStar?: ((sessionId: string, on: boolean) => void) | undefined;
  onSnooze?: ((session: SessionSummary, until: Date | undefined | false) => void) | undefined;
  onFlag?: ((session: SessionSummary, on: boolean) => void) | undefined;
  owned?: ReadonlyMap<string, readonly PullRequestSummary[]> | undefined;
  offerResume?: boolean;
  leads?: LeadsOpen | undefined;
}

/** A session's row as leads.ts arranged it: a plain row, a lead's with its workers, a worker's pointer. */
export function ListedRow({ row, shared }: { row: ArrangedListed; shared: RowShared }) {
  if (row.pointer !== undefined) return <PointerRow row={row} pointer={row.pointer} shared={shared} />;
  if (row.workers !== undefined) return <LeadRow row={row} workers={row.workers} shared={shared} />;
  return plainRow(row, shared);
}

function plainRow(row: ArrangedListed, shared: RowShared, extra: { lead?: Parameters<typeof SessionRow>[0]['lead']; showGroup?: boolean } = {}): ReactNode {
  const { session, group } = row;
  return (
    <SessionRow
      key={session.sessionId}
      session={session}
      group={group}
      showGroup={extra.showGroup ?? shared.showGroup}
      onOpen={shared.onOpen}
      onStep={shared.onStep}
      isOpen={session.sessionId === shared.openSessionId}
      starred={shared.starred?.has(session.sessionId) ?? false}
      onStar={shared.onStar}
      onSnooze={shared.onSnooze}
      onFlag={shared.onFlag}
      owned={shared.owned?.get(session.sessionId)}
      offerResume={shared.offerResume ?? false}
      lead={extra.lead}
      under={row.under?.leadName}
      onReported={shared.leads?.onReported}
    />
  );
}

function LeadRow({ row, workers, shared }: { row: ArrangedListed; workers: NonNullable<ArrangedListed['workers']>; shared: RowShared }) {
  const listId = useId();
  const leadId = row.session.sessionId;
  const open = shared.leads?.isOpen(leadId) ?? true;
  const total = row.workerTotal ?? workers.length;
  const text = open ? workerCount(total) : closedWorkersText(total, workers);
  const lead = { text, open, listId, hasWorkers: workers.length > 0, onToggle: () => shared.leads?.toggle(leadId, !open) };
  return (
    <>
      {plainRow(row, shared, { lead })}
      {workers.length > 0 && (
        <li className="lead-workers-item">
          <ul className="sessions lead-workers" id={listId} hidden={!open} aria-label={`Workers of ${plainText(row.session.name)}`} data-lead-workers={leadId}>
            {workers.map((worker) => plainRow(worker, shared, { showGroup: shared.showGroup || worker.repo !== undefined }))}
          </ul>
        </li>
      )}
    </>
  );
}

/** The pointer a worker leaves in its own repo group: its name, which opens it, then "↳ under <lead> (<repo>)". */
function PointerRow({ row, pointer, shared }: { row: ArrangedListed; pointer: NonNullable<ArrangedListed['pointer']>; shared: RowShared }) {
  const { session } = row;
  const name = plainText(session.name);
  const onKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!shared.onStep || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    shared.onStep(session.sessionId, event.key === 'ArrowDown' ? 1 : -1);
  };
  return (
    <li className={['session', 'lead-pointer', session.finished && 'finished', session.sessionId === shared.openSessionId && 'open'].filter(Boolean).join(' ')} data-lead-pointer={session.sessionId}>
      <span className="session-name lead-pointer-name">
        {shared.onOpen ? (
          <button
            type="button"
            className="session-open"
            data-open-session={session.sessionId}
            aria-controls={SESSION_VIEW_ID}
            aria-current={session.sessionId === shared.openSessionId || undefined}
            onClick={() => shared.onOpen?.(session.sessionId)}
            onKeyDown={onKey}
          >
            <Highlight text={name} />
          </button>
        ) : (
          <Highlight text={name} />
        )}
      </span>
      <span className="lead-pointer-text">
        <span aria-hidden="true">↳ </span>
        <Highlight text={pointerText(plainText(pointer.leadName), plainText(pointer.leadRepo))} />
      </span>
    </li>
  );
}
