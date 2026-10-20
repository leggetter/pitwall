// Session rows and the Finished section (W19, W21, W23): the real SessionRow and FinishedSection,
// with fixture sessions, in the session list's own surface. Each row is shown as it is in a group,
// and as it is in Needs you and All sessions, where line 2 starts with its group's label. Each
// specimen keeps its own open state, so it can be clicked.

import { useState } from 'react';
import type { SessionGroup, SessionSummary } from '../../../src/shared/protocol.js';
import { FinishedSection } from '../components/SessionList.js';
import { SessionRow } from '../components/SessionRow.js';
import type { Listed } from '../sessions.js';
import { APP_DIR, AWKWARD_ROWS, FINISHED_ROWS, group, JOBS_DIR, NOW, ROOT, STATE_ROWS, STATUS_ROWS } from './fixtures.js';
import { Specimen } from './kit.js';

/** Rows all in one group, as a group's own list has them. */
const inGroup = (label: string, sessions: SessionSummary[], key = APP_DIR): Listed[] => {
  const shown = group(label, sessions, { key });
  return sessions.map((session) => ({ session, group: shown }));
};

/** Groups for the views' rows, so their labels differ: a repo, another repo, and the root's own directory. */
const VIEW_GROUPS: Pick<SessionGroup, 'root' | 'key' | 'label' | 'kind'>[] = [
  { root: ROOT, key: APP_DIR, label: 'pitwall-test-app', kind: 'git' },
  { root: ROOT, key: JOBS_DIR, label: 'pitwall-test-jobs', kind: 'git' },
  { root: ROOT, key: ROOT, label: 'code', kind: 'directory' },
];

/** Rows from several groups, as Needs you and All sessions have them. */
const acrossGroups = (sessions: SessionSummary[]): Listed[] =>
  sessions.map((session, index) => {
    const { root, key, label, kind } = VIEW_GROUPS[index % VIEW_GROUPS.length]!;
    return { session, group: { root, key, label, kind, sessions: [session] } };
  });

/** Rows as the session list shows them; clicking one marks it open. */
function Rows({ rows, showGroup = false, openSessionId }: { rows: Listed[]; showGroup?: boolean; openSessionId?: string }) {
  const [open, setOpen] = useState(openSessionId);
  return (
    <div className="session-list uikit-rows">
      <div className="session-list-body">
        <ul className="sessions">
          {rows.map(({ session, group: shown }) => (
            <SessionRow
              key={session.sessionId}
              session={session}
              group={shown}
              showGroup={showGroup}
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
function Finished({ rows, collapsed = false, showGroup = false }: { rows: Listed[]; collapsed?: boolean; showGroup?: boolean }) {
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
            showGroup={showGroup}
            now={NOW}
            onOpen={(id) => setOpen((current) => (current === id ? undefined : id))}
            openSessionId={open}
          />
        </ul>
      </div>
    </div>
  );
}

/** One row, captioned with its state. `hovered` draws it as the pointer would (gallery.css). */
function StateRow({ caption, session, open = false, hovered = false, showGroup }: { caption: string; session: SessionSummary; open?: boolean; hovered?: boolean; showGroup: boolean }) {
  const rows = showGroup ? acrossGroups([session]) : inGroup('pitwall-test-states', [session]);
  return (
    <div className={hovered ? 'uikit-hovered' : undefined}>
      <p className="uikit-note">{caption}</p>
      <Rows rows={rows} showGroup={showGroup} {...(open ? { openSessionId: session.sessionId } : {})} />
    </div>
  );
}

function States({ showGroup }: { showGroup: boolean }) {
  return (
    <div className="uikit-stack">
      <StateRow caption="Default" session={STATE_ROWS.default} showGroup={showGroup} />
      <StateRow caption="Hover" session={STATE_ROWS.hover} hovered showGroup={showGroup} />
      <StateRow caption="Open: the selected fill and ring" session={STATE_ROWS.open} open showGroup={showGroup} />
      <StateRow caption="Needs you: the bar and the badge, no tint" session={STATE_ROWS.needsYou} showGroup={showGroup} />
      <StateRow caption="Needs you and open: the ring and the bar" session={STATE_ROWS.needsYouOpen} open showGroup={showGroup} />
      <StateRow caption="Finished: the name at 400, muted" session={STATE_ROWS.finished} showGroup={showGroup} />
    </div>
  );
}

/** Long text and narrow lists, at the widths the session list has from 1,200 px. */
const NARROW_ROWS = [STATUS_ROWS[0]!, STATUS_ROWS[1]!, STATUS_ROWS[2]!, STATUS_ROWS[11]!, ...AWKWARD_ROWS.slice(0, 4)];

export function SessionRows() {
  return (
    <>
      <Specimen
        title="Every status, in a group"
        note="One row per status, named after it: waiting, blocked, asked you, busy, working, idle, unknown, not running, done, stopped, failed and stale. Idle has no badge in the list; the session view shows it. Click a row to mark it open."
      >
        <Rows rows={inGroup('pitwall-test-statuses', STATUS_ROWS)} />
      </Specimen>
      <Specimen title="Every status, in Needs you and All sessions" note="Line 2 starts with the group's label; the root's own directory shows its path.">
        <Rows rows={acrossGroups(STATUS_ROWS)} showGroup />
      </Specimen>
      <Specimen title="States, in a group" note="Each state in the Session rows table. Hover any row, or Tab to a name, for the live hover and focus.">
        <States showGroup={false} />
      </Specimen>
      <Specimen title="States, in Needs you and All sessions">
        <States showGroup />
      </Specimen>
      <Specimen
        title="Long and awkward text, in a group"
        note="A long title, a long name, a long Asked line, a long waiting reason, unbroken text, no prompt yet, and the two transcript notes. Each stays on its line, with an ellipsis."
      >
        <Rows rows={inGroup('pitwall-test-awkward', AWKWARD_ROWS)} />
      </Specimen>
      <Specimen title="Long and awkward text, in Needs you and All sessions">
        <Rows rows={acrossGroups(AWKWARD_ROWS)} showGroup />
      </Specimen>
      <Specimen title="360 px wide" note="The session list's width at 1,200 px. Line 1 stays one line: the title gives way first, then the name." width={360}>
        <Rows rows={acrossGroups(NARROW_ROWS)} showGroup />
      </Specimen>
      <Specimen title="440 px wide" note="The session list's width at 1,440 px." width={440}>
        <Rows rows={acrossGroups(NARROW_ROWS)} showGroup />
      </Specimen>
    </>
  );
}

export function FinishedSections() {
  return (
    <>
      <Specimen title="Collapsed" note="As it starts. The line counts the finished sessions that asked you something, which never count as needing you.">
        <Finished rows={inGroup('pitwall-test-finished', FINISHED_ROWS, JOBS_DIR)} collapsed />
      </Specimen>
      <Specimen title="Open, in a group" note="Finished rows are muted. One that asked you something has an outline badge saying so.">
        <Finished rows={inGroup('pitwall-test-finished', FINISHED_ROWS, JOBS_DIR)} />
      </Specimen>
      <Specimen title="Open, in All sessions" note="With each row's group label.">
        <Finished rows={acrossGroups(FINISHED_ROWS)} showGroup />
      </Specimen>
    </>
  );
}
