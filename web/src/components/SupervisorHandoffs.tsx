// What the supervisor sent and started in this run (M5, W124; docs/design-system.md, 4: Supervisor):
// a row per session, each with its state from pitwall's index and "Open <name> →", which opens that
// session's view as clicking it in the list does. The supervisor never sees a session's reply (Phil,
// 2026-11-02), so this is where you go on from: you carry on in the session itself.
//
// - Read from the snapshot alone: the supervisor's hand-offs (SupervisorState.handoffs) and the
//   sessions pitwall lists. No supervisor turn, no request.
// - A session that needs you, by pitwall's own Needs you, says so on its row, "<name> needs you:
//   <reason>", and comes first.
// - A started session the index hasn't listed yet says "Starting…" and has no Open, since there's
//   nothing to open; Open appears with the next snapshot that lists it. So does a resumed one (W127),
//   "Resumed <name>", until the index lists it running again.
// - A copy Claude Code started instead of resuming (W127) says "Resumed a copy of <name>", with a
//   line saying the message went to the copy; Open opens the copy, by its own short id.
// - Names are text in <bdi>: a session's name is its own, or the one the card showed.
// - A region named by its <h3>, "Sent and started (2)", above the drafts; its list scrolls past 30% of
//   the view (ScrollBox). A snapshot that changes it announces nothing: Needs you's own count does.

import { useId } from 'react';
import type { SessionSummary, SupervisorHandoff } from '../../../src/shared/protocol.js';
import { statusBadge } from '../sessions.js';
import { HANDOFF_COPY_NOTE, handoffName, handoffRows, handoffVerb } from '../supervisor.js';
import { Badge } from './Badge.js';
import { Button } from './Button.js';
import { ScrollBox } from './ScrollBox.js';
import { Timestamp } from './Timestamp.js';

/** The region's heading, before its count. */
export const HANDOFFS_TITLE = 'Sent and started';

/** What a started session says before the index lists it. */
export const HANDOFF_STARTING = 'Starting…';

/** The line under the heading: where the conversation goes on. */
export const HANDOFFS_NOTE = "The supervisor doesn't see their replies. Open a session to carry on there.";

export interface SupervisorHandoffsProps {
  handoffs: readonly SupervisorHandoff[] | undefined;
  /** Every session the snapshot lists. */
  sessions: readonly SessionSummary[];
  /** Opens a session's view, as its row in the list does. */
  onOpenSession?: ((sessionId: string) => void) | undefined;
}

export function SupervisorHandoffs({ handoffs, sessions, onOpenSession }: SupervisorHandoffsProps) {
  const headingId = useId();
  const rows = handoffRows(handoffs, sessions);
  if (rows.length === 0) return null;
  return (
    <section className="supervisor-handoffs" aria-labelledby={headingId} data-supervisor-handoffs="">
      <h3 className="supervisor-approvals-title" id={headingId}>
        {HANDOFFS_TITLE} <span className="supervisor-approvals-count">({rows.length})</span>
      </h3>
      <p className="supervisor-handoffs-note">{HANDOFFS_NOTE}</p>
      <ScrollBox className="supervisor-approvals-scroll supervisor-handoffs-scroll" label={HANDOFFS_TITLE}>
        <ul className="supervisor-handoff-list">
          {rows.map((row) => {
            const name = handoffName(row);
            const badge = row.session === undefined ? undefined : statusBadge(row.session);
            return (
              <li key={row.handoff.id} className={['supervisor-handoff', row.needs !== undefined && 'supervisor-handoff-needs-you'].filter(Boolean).join(' ')} data-handoff={row.handoff.kind}>
                <div className="supervisor-handoff-line">
                  <span className="supervisor-handoff-what">
                    {handoffVerb(row.handoff)} <bdi className="supervisor-handoff-name">{name}</bdi>
                  </span>
                  {badge !== undefined ? (
                    <Badge look={badge.look} lead={badge.dot === true ? 'dot' : undefined}>
                      {badge.label}
                    </Badge>
                  ) : (
                    <span className="supervisor-handoff-starting">{row.handoff.kind === 'message' ? 'Not listed' : HANDOFF_STARTING}</span>
                  )}
                  <Timestamp className="supervisor-handoff-at" at={row.handoff.at} />
                  {row.session !== undefined && onOpenSession !== undefined && (
                    <Button size="sm" variant="outline" className="supervisor-handoff-open" onClick={() => onOpenSession(row.session!.sessionId)} data-handoff-open="">
                      {row.handoff.copy === true ? 'Open the copy' : <>Open <bdi>{name}</bdi></>} <span aria-hidden="true">→</span>
                    </Button>
                  )}
                </div>
                {row.handoff.copy === true && (
                  <p className="supervisor-handoff-copy" data-handoff-copy="">
                    {HANDOFF_COPY_NOTE}
                  </p>
                )}
                {row.needs !== undefined && (
                  <p className="supervisor-handoff-needs" data-handoff-needs="">
                    {row.needs}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </ScrollBox>
    </section>
  );
}
