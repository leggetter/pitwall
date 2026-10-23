// Session rows and the Finished section (W19, W21, W23): the real SessionRow and FinishedSection,
// with fixture sessions, in the session list's own surface, and rows with their star toggles (W53). Each row is shown as it is in a group,
// and as it is in Needs you and All sessions, where line 2 starts with its group's label. Each
// specimen keeps its own open state, so it can be clicked.

import { useState } from 'react';
import type { SessionGroup, SessionSummary } from '../../../src/shared/protocol.js';
import { FinishedSection } from '../components/SessionList.js';
import { SessionRow } from '../components/SessionRow.js';
import { listScope, type Listed } from '../sessions.js';
import { APP_DIR, AWKWARD_ROWS, FINISHED_ROWS, group, JOBS_DIR, ROOT, STATE_ROWS, STATUS_ROWS, WORKED_SNAPSHOT } from './fixtures.js';
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

/**
 * Rows as the session list shows them; clicking one marks it open. With `starred`, each has its star
 * toggle, the ids in it starred to start with, and pressing one stars or unstars it (W53).
 */
function Rows({ rows, showGroup = false, openSessionId, starred }: { rows: Listed[]; showGroup?: boolean; openSessionId?: string; starred?: readonly string[] }) {
  const [open, setOpen] = useState(openSessionId);
  const [stars, setStars] = useState<ReadonlySet<string>>(() => new Set(starred));
  const onStar = (id: string, on: boolean) =>
    setStars((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
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
              onOpen={(id) => setOpen((current) => (current === id ? undefined : id))}
              isOpen={session.sessionId === open}
              starred={stars.has(session.sessionId)}
              onStar={starred ? onStar : undefined}
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
            onOpen={(id) => setOpen((current) => (current === id ? undefined : id))}
            openSessionId={open}
          />
        </ul>
      </div>
    </div>
  );
}

/** One row, captioned with its state. `hovered` draws it as the pointer would (gallery.css). `starred` gives it its star toggle, on or off (W53). */
function StateRow({
  caption,
  session,
  open = false,
  hovered = false,
  showGroup,
  starred,
}: {
  caption: string;
  session: SessionSummary;
  open?: boolean;
  hovered?: boolean;
  showGroup: boolean;
  starred?: boolean;
}) {
  const rows = showGroup ? acrossGroups([session]) : inGroup('pitwall-test-states', [session]);
  const stars = starred === undefined ? {} : { starred: starred ? [session.sessionId] : [] };
  return (
    <div className={hovered ? 'uikit-hovered' : undefined}>
      <p className="uikit-note">{caption}</p>
      <Rows rows={rows} showGroup={showGroup} {...(open ? { openSessionId: session.sessionId } : {})} {...stars} />
    </div>
  );
}

/** A starred row, and the star on the others: on hover or focus alone, so the list stays calm (W53). */
function StarredStates({ showGroup }: { showGroup: boolean }) {
  return (
    <div className="uikit-stack">
      <StateRow caption="Starred: the filled star, always shown" session={STATE_ROWS.default} showGroup={showGroup} starred />
      <StateRow caption="Starred and open" session={STATE_ROWS.open} open showGroup={showGroup} starred />
      <StateRow caption="Starred, needs you" session={STATE_ROWS.needsYou} showGroup={showGroup} starred />
      <StateRow caption="Not starred: no star until the row is hovered or focused" session={STATE_ROWS.hover} showGroup={showGroup} starred={false} />
      <StateRow caption="Not starred, hovered: the outlined star" session={STATE_ROWS.hover} hovered showGroup={showGroup} starred={false} />
      <StateRow caption="Finished and starred" session={STATE_ROWS.finished} showGroup={showGroup} starred />
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
        title="Starred, in a group"
        note="Each row's star toggle at the end of line 1, after the time, in a slot every row keeps: filled and shown while the session is starred, outlined and shown on hover and focus otherwise, and always on a touch screen. Press a star to toggle it; it never opens the session. Tab to a name to see its row's star."
      >
        <StarredStates showGroup={false} />
      </Specimen>
      <Specimen title="Starred, in Needs you, All sessions and Starred" note="The same, with line 2 starting with the group's label.">
        <StarredStates showGroup />
      </Specimen>
      <Specimen
        title="Starred rows, 360 px wide"
        note="The session list's width at 1,200 px: the star keeps its place, and line 1 still gives way title first, then name."
        width={360}
      >
        <Rows rows={acrossGroups(NARROW_ROWS)} showGroup starred={NARROW_ROWS.filter((_, index) => index % 2 === 0).map((row) => row.sessionId)} />
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
      <Specimen
        title="Sessions that worked in other repos, in All sessions"
        note="Each session once, its line 2 naming the group it started in, the only one it's listed under: pitwall-test-across-repos under pitwall-test-app, pitwall-test-from-root under ~/code, though both worked in pitwall-test-api and pitwall-test-docs. The session view names those."
      >
        <Rows rows={listScope(WORKED_SNAPSHOT.groups, { kind: 'all' }).current} showGroup />
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
