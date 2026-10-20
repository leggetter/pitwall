// Session rows and group sections (W19): the real GroupSection and SessionRow, with fixture
// sessions. Each specimen keeps its own open and collapsed state, so it can be clicked.

import { useState } from 'react';
import type { SessionGroup, SessionSummary } from '../../../src/shared/protocol.js';
import { GroupSection } from '../components/GroupSection.js';
import {
  ALL_FINISHED_GROUP,
  APP_DIR,
  APP_GROUP,
  AWKWARD_ROWS,
  FINISHED_ROWS,
  group,
  JOBS_DIR,
  JOBS_GROUP,
  LONG_LABEL_GROUP,
  NOTES_GROUP,
  NOW,
  OPEN_ROWS,
  RELAY_ROWS,
  SERVICE_GROUP,
  STATUS_ROWS,
} from './fixtures.js';
import { Specimen } from './kit.js';

interface GroupSpecimenProps {
  group: SessionGroup;
  /** The sessions left after filtering. Default: all of them. */
  sessions?: SessionSummary[];
  collapsed?: boolean;
  finishedCollapsed?: boolean;
  showRoot?: boolean;
  /** The session whose view is open, to start with. Clicking a row opens it instead. */
  openSessionId?: string;
}

/** A GroupSection with its own state: the header toggles it, and clicking a row marks it open. */
function LiveGroup({ group: shown, sessions, collapsed = false, finishedCollapsed = false, showRoot = false, openSessionId }: GroupSpecimenProps) {
  const [isCollapsed, setCollapsed] = useState(collapsed);
  const [isFinishedCollapsed, setFinishedCollapsed] = useState(finishedCollapsed);
  const [open, setOpen] = useState(openSessionId);
  return (
    <GroupSection
      group={shown}
      sessions={sessions ?? shown.sessions}
      collapsed={isCollapsed}
      onToggle={() => setCollapsed((value) => !value)}
      finishedCollapsed={isFinishedCollapsed}
      onToggleFinished={() => setFinishedCollapsed((value) => !value)}
      showRoot={showRoot}
      now={NOW}
      onOpen={(id) => setOpen((current) => (current === id ? undefined : id))}
      openSessionId={open}
    />
  );
}

/** A group of rows in `key`, so only a session elsewhere shows its path, as in the app. */
const rows = (label: string, sessions: SessionSummary[], key = APP_DIR) => group(label, sessions, { key });

export function SessionRows() {
  return (
    <>
      <Specimen
        title="Every status"
        note="One row per status, named after it: waiting, blocked, asked you, busy, working, idle, unknown, not running, done, stopped, failed and stale. Click a row to mark it open."
      >
        <LiveGroup group={rows('pitwall-test-statuses', STATUS_ROWS)} />
      </Specimen>
      <Specimen title="Finished rows" note="Finished background sessions sit in the group's Finished list, muted. One asked a question, which isn't counted as needing you.">
        <LiveGroup group={rows('pitwall-test-finished', FINISHED_ROWS, JOBS_DIR)} />
      </Specimen>
      <Specimen title="Relay exchanges" note="Rows whose last message from pitwall was delivered (with a reply), held, refused, not sent, or may have arrived.">
        <LiveGroup group={rows('pitwall-test-relay', RELAY_ROWS)} />
      </Specimen>
      <Specimen
        title="Long and awkward text"
        note="A long title, a long name and path, a worktree outside its group, unbroken text, a working directory that's gone, and the two transcript notes."
      >
        <LiveGroup group={rows('pitwall-test-awkward', AWKWARD_ROWS)} />
      </Specimen>
      <Specimen title="Open" note="The row whose session view is open, and one that's open while it needs you.">
        <div className="uikit-stack">
          <LiveGroup group={rows('pitwall-test-open', [OPEN_ROWS[0]!])} openSessionId={OPEN_ROWS[0]!.sessionId} />
          <LiveGroup group={rows('pitwall-test-open-needs-you', [OPEN_ROWS[1]!])} openSessionId={OPEN_ROWS[1]!.sessionId} />
        </div>
      </Specimen>
    </>
  );
}

export function GroupSections() {
  return (
    <>
      <Specimen title="Collapsed" note="With a need-you count, without one (a directory), and with finished sessions inside. Click a header to open it.">
        <div className="uikit-stack">
          <LiveGroup group={APP_GROUP} collapsed />
          <LiveGroup group={NOTES_GROUP} collapsed />
          <LiveGroup group={JOBS_GROUP} collapsed />
        </div>
      </Specimen>
      <Specimen title="Open, with a need-you count">
        <LiveGroup group={APP_GROUP} />
      </Specimen>
      <Specimen title="Open, with the Finished list closed" note="The Finished line counts the finished sessions that asked you something.">
        <LiveGroup group={JOBS_GROUP} finishedCollapsed />
      </Specimen>
      <Specimen title="Open, with the Finished list open">
        <LiveGroup group={JOBS_GROUP} />
      </Specimen>
      <Specimen title="Every session finished">
        <LiveGroup group={ALL_FINISHED_GROUP} />
      </Specimen>
      <Specimen title="Under one of several roots" note='With more than one root, the header says which: "in ~/work".'>
        <LiveGroup group={SERVICE_GROUP} showRoot />
      </Specimen>
      <Specimen title="Filtered" note="When a filter hides some sessions, the count says how many are shown.">
        <LiveGroup group={APP_GROUP} sessions={APP_GROUP.sessions.slice(0, 2)} />
      </Specimen>
      <Specimen title="A long label">
        <LiveGroup group={LONG_LABEL_GROUP} />
      </Specimen>
    </>
  );
}
