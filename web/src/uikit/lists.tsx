// Session rows and the Finished section (W19, W21): the real SessionRow and FinishedSection, with
// fixture sessions, in the session list's own surface. Each specimen keeps its own open state, so it
// can be clicked.

import { useState } from 'react';
import type { SessionSummary } from '../../../src/shared/protocol.js';
import { FinishedSection } from '../components/SessionList.js';
import { SessionRow } from '../components/SessionRow.js';
import type { Listed } from '../sessions.js';
import { APP_DIR, AWKWARD_ROWS, FINISHED_ROWS, group, JOBS_DIR, NOW, OPEN_ROWS, RELAY_ROWS, STATUS_ROWS } from './fixtures.js';
import { Specimen } from './kit.js';

/** Rows in `key`'s group, so only a session elsewhere shows its path, as in the app. */
const listed = (label: string, sessions: SessionSummary[], key = APP_DIR): Listed[] => {
  const shown = group(label, sessions, { key });
  return sessions.map((session) => ({ session, group: shown }));
};

/** Rows as the session list shows them; clicking one marks it open. */
function Rows({ rows, openSessionId }: { rows: Listed[]; openSessionId?: string }) {
  const [open, setOpen] = useState(openSessionId);
  return (
    <div className="session-list uikit-rows">
      <div className="session-list-body">
        <ul className="sessions">
          {rows.map(({ session, group: shown }) => (
            <SessionRow
              key={session.sessionId}
              session={session}
              groupKey={shown.key}
              now={NOW}
              onOpen={(id) => setOpen((current) => (current === id ? undefined : id))}
              isOpen={session.sessionId === open}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

/** A Finished section at the foot of a list, opening and closing as in the app. */
function Finished({ rows, collapsed = false }: { rows: Listed[]; collapsed?: boolean }) {
  const [isCollapsed, setCollapsed] = useState(collapsed);
  const [open, setOpen] = useState<string>();
  return (
    <div className="session-list uikit-rows">
      <div className="session-list-body">
        <ul className="sessions">
          <FinishedSection
            finished={rows}
            collapsed={isCollapsed}
            onToggle={() => setCollapsed((value) => !value)}
            now={NOW}
            onOpen={(id) => setOpen((current) => (current === id ? undefined : id))}
            openSessionId={open}
          />
        </ul>
      </div>
    </div>
  );
}

export function SessionRows() {
  return (
    <>
      <Specimen
        title="Every status"
        note="One row per status, named after it: waiting, blocked, asked you, busy, working, idle, unknown, not running, done, stopped, failed and stale. Click a row to mark it open."
      >
        <Rows rows={listed('pitwall-test-statuses', STATUS_ROWS)} />
      </Specimen>
      <Specimen title="Relay exchanges" note="Rows whose last message from pitwall was delivered (with a reply), held, refused, not sent, or may have arrived.">
        <Rows rows={listed('pitwall-test-relay', RELAY_ROWS)} />
      </Specimen>
      <Specimen
        title="Long and awkward text"
        note="A long title, a long name and path, a worktree outside its group, unbroken text, a working directory that's gone, and the two transcript notes."
      >
        <Rows rows={listed('pitwall-test-awkward', AWKWARD_ROWS)} />
      </Specimen>
      <Specimen title="Open" note="The row whose session view is open, and one that's open while it needs you.">
        <div className="uikit-stack">
          <Rows rows={listed('pitwall-test-open', [OPEN_ROWS[0]!])} openSessionId={OPEN_ROWS[0]!.sessionId} />
          <Rows rows={listed('pitwall-test-open-needs-you', [OPEN_ROWS[1]!])} openSessionId={OPEN_ROWS[1]!.sessionId} />
        </div>
      </Specimen>
    </>
  );
}

export function FinishedSections() {
  return (
    <>
      <Specimen title="Collapsed" note="As it starts. The line counts the finished sessions that asked you something, which never count as needing you.">
        <Finished rows={listed('pitwall-test-finished', FINISHED_ROWS, JOBS_DIR)} collapsed />
      </Specimen>
      <Specimen title="Open" note="Finished rows are muted.">
        <Finished rows={listed('pitwall-test-finished', FINISHED_ROWS, JOBS_DIR)} />
      </Specimen>
    </>
  );
}
