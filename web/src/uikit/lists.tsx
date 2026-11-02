// Session rows and the Finished section (W19, W21, W23): the real SessionRow and FinishedSection,
// with fixture sessions, in the session list's own surface, and rows with their star toggles (W53),
// rows with their Not needed now toggles, marked and not (W88), ended sessions' rows and Show older
// among them (W67). Each row is shown as it is in a group,
// and as it is in Needs you and All sessions, where line 2 starts with its group's label. Each
// specimen keeps its own open state, so it can be clicked.

import { useState } from 'react';
import type { SessionGroup, SessionSummary } from '../../../src/shared/protocol.js';
import { FinishedSection, type OlderEnded } from '../components/SessionList.js';
import { SessionRow } from '../components/SessionRow.js';
import { withMark, withoutMark, type NotNeeded } from '../notNeeded.js';
import { listScope, type Listed } from '../sessions.js';
import { ago, APP_DIR, AWKWARD_ROWS, ENDED_ROWS, FINISHED_ROWS, group, JOBS_DIR, OLDER_ENDED_ROWS, ROOT, session, STATE_ROWS, STATUS_ROWS, statusRow, WORKED_SNAPSHOT } from './fixtures.js';
import { Specimen } from './kit.js';

/** Rows all in one group, as a group's own list has them. */
export const inGroup = (label: string, sessions: SessionSummary[], key = APP_DIR): Listed[] => {
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
export const acrossGroups = (sessions: SessionSummary[]): Listed[] =>
  sessions.map((session, index) => {
    const { root, key, label, kind } = VIEW_GROUPS[index % VIEW_GROUPS.length]!;
    return { session, group: { root, key, label, kind, sessions: [session] } };
  });

/**
 * Rows as the session list shows them; clicking one marks it open. With `starred`, each has its star
 * toggle, the ids in it starred to start with, and pressing one stars or unstars it (W53). With
 * `notNeeded`, each that needs you has its Not needed now toggle, the sessions in it marked to start
 * with, and pressing one marks it or takes the mark away (W88); with `leave` too, a marked row leaves,
 * as in Needs you.
 */
export function Rows({
  rows,
  showGroup = false,
  openSessionId,
  starred,
  notNeeded,
  leave = false,
}: {
  rows: Listed[];
  showGroup?: boolean;
  openSessionId?: string;
  starred?: readonly string[];
  notNeeded?: readonly SessionSummary[];
  leave?: boolean;
}) {
  const [open, setOpen] = useState(openSessionId);
  const [marks, setMarks] = useState<NotNeeded>(() => (notNeeded ?? []).reduce<NotNeeded>((current, marked) => withMark(current, marked), new Map()));
  const onNotNeeded = (session: SessionSummary, on: boolean) => setMarks((current) => (on ? withMark(current, session) : withoutMark(current, session.sessionId)));
  const shownRows = leave ? rows.filter(({ session }) => !marks.has(session.sessionId)) : rows;
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
          {shownRows.map(({ session, group: shown }) => (
            <SessionRow
              key={session.sessionId}
              session={session}
              group={shown}
              showGroup={showGroup}
              onOpen={(id) => setOpen((current) => (current === id ? undefined : id))}
              isOpen={session.sessionId === open}
              starred={stars.has(session.sessionId)}
              onStar={starred ? onStar : undefined}
              notNeeded={marks}
              onNotNeeded={notNeeded ? onNotNeeded : undefined}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * A Finished section at the foot of a list, opening and closing as in the app. With `older`, the
 * selection's ended sessions older than ENDED_SHOWN_DAYS, behind Show older, which shows them after
 * the rows, or from the start with `olderShown` (W67).
 */
function Finished({
  rows,
  collapsed = false,
  showGroup = false,
  older = [],
  olderShown = false,
}: {
  rows: Listed[];
  collapsed?: boolean;
  showGroup?: boolean;
  older?: Listed[];
  olderShown?: boolean;
}) {
  const [isCollapsed, setCollapsed] = useState(collapsed);
  const [open, setOpen] = useState<string>();
  const [shown, setShown] = useState(olderShown);
  const toggle: OlderEnded | undefined = older.length > 0 ? { count: older.length, shown, onToggle: () => setShown((value) => !value) } : undefined;
  return (
    <div className="session-list uikit-rows">
      <div className="session-list-body">
        <ul className="sessions">
          <FinishedSection
            finished={shown ? [...rows, ...older] : rows}
            collapsed={isCollapsed}
            onToggle={() => setCollapsed((value) => !value)}
            showGroup={showGroup}
            onOpen={(id) => setOpen((current) => (current === id ? undefined : id))}
            openSessionId={open}
            older={toggle}
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
      <StateRow caption="Ended and starred (W67)" session={STATE_ROWS.ended} showGroup={showGroup} starred />
    </div>
  );
}

/** The rows that need you, one for each kind of need, for the Not needed now specimens (W88). */
const NEEDING_ROWS = [statusRow('waiting'), statusRow('blocked'), statusRow('asked-you')];

/**
 * Not needed now (W88): rows that need you, with the toggle on hover or focus, and rows marked not
 * needed now, quiet: no bar, the badge outlined, "Not needed now" on line 2, the toggle filled.
 */
function NotNeededStates({ showGroup }: { showGroup: boolean }) {
  const rows = (sessions: SessionSummary[]) => (showGroup ? acrossGroups(sessions) : inGroup('pitwall-test-not-needed', sessions));
  return (
    <div className="uikit-stack">
      <div>
        <p className="uikit-note">Needs you: no toggle until the row is hovered or focused</p>
        <Rows rows={rows([STATE_ROWS.needsYou])} showGroup={showGroup} notNeeded={[]} starred={[]} />
      </div>
      <div className="uikit-hovered">
        <p className="uikit-note">Needs you, hovered: the outlined toggle, under the star</p>
        <Rows rows={rows([STATE_ROWS.needsYou])} showGroup={showGroup} notNeeded={[]} starred={[]} />
      </div>
      <div>
        <p className="uikit-note">Not needed now, one for each need: no bar, the badge outlined, "Not needed now" before what it needs, and the filled toggle, always shown</p>
        <Rows rows={rows(NEEDING_ROWS)} showGroup={showGroup} notNeeded={NEEDING_ROWS} starred={[]} />
      </div>
      <div>
        <p className="uikit-note">Not needed now and open</p>
        <Rows rows={rows([STATE_ROWS.needsYouOpen])} showGroup={showGroup} notNeeded={[STATE_ROWS.needsYouOpen]} starred={[STATE_ROWS.needsYouOpen.sessionId]} openSessionId={STATE_ROWS.needsYouOpen.sessionId} />
      </div>
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
      <StateRow caption="Ended (W67): muted as finished, with Ended where a finished session has its state" session={STATE_ROWS.ended} showGroup={showGroup} />
    </div>
  );
}

/** Sessions with sub-agents running (W77): the count ends line 2, quietly, and never gives way. */
const RUNNING_ROWS = [
  session('agents-two', { subagentsRunning: 2, lastActivityAt: ago(0.2) }),
  session('agents-one', { subagentsRunning: 1, status: 'busy', lastActivityAt: ago(0.4) }),
  session('agents-long-prompt', {
    subagentsRunning: 12,
    lastUserPrompt: 'Review every made-up export job for retries, the batch writer and the CSV export, and report what is missing from their tests.',
    lastActivityAt: ago(1),
  }),
  session('agents-none', { lastActivityAt: ago(3) }),
];

/** Long text and narrow lists, at the widths the session list has from 1,200 px. */
const NARROW_ROWS = [statusRow('waiting'), statusRow('blocked'), statusRow('asked-you'), statusRow('stale'), ...AWKWARD_ROWS.slice(0, 4)];

export function SessionRows() {
  return (
    <>
      <Specimen
        title="Every status, in a group"
        note="One row per status, named after it: waiting, blocked with Claude Code's own line on line 2, asked you, busy, working, idle, unknown, not running, done, stopped, failed, stale and ended (W67), then waiting for your prompt after a restart, blocked with a job file pitwall couldn't read, and blocked with nothing that needs you, which has no badge (W69). Idle has no badge in the list; the session view shows it. Click a row to mark it open."
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
        title="Not needed now (W88), in a group"
        note="On the row of a session that needs you, at the end of line 2, under the star: the Not needed now toggle, outlined and shown on hover and focus, filled and always shown while it's marked. A marked row has no bar, its badge keeps its text, outlined, and line 2 says Not needed now, quietly, before what it needs, which is muted. Press a toggle to mark it or take the mark away; it never opens the session."
      >
        <NotNeededStates showGroup={false} />
      </Specimen>
      <Specimen title="Not needed now, in All sessions and Starred" note="The same, with line 2 starting with the group's label: Not needed now comes after it.">
        <NotNeededStates showGroup />
      </Specimen>
      <Specimen
        title="Not needed now, in Needs you, 360 px wide"
        note="Every row needs you, so every row has the toggle. Press one: the row leaves at once, as it leaves Needs you, and focus goes to the next row's toggle in the app. Line 1 still gives way title first, then name."
        width={360}
      >
        <Rows rows={acrossGroups(NEEDING_ROWS)} showGroup notNeeded={[]} starred={[]} leave />
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
      <Specimen
        title="Sub-agents running (W77)"
        note="While any of a session's sub-agents run, line 2 ends with how many, quietly, in the group label's colour: 2 sub-agents running, or 1 sub-agent running, after a · when something comes before it. What it was last asked gives way first; the count is never cut. Nothing when none runs."
      >
        <Rows rows={inGroup('pitwall-test-app', RUNNING_ROWS)} />
      </Specimen>
      <Specimen title="Sub-agents running, in Needs you and All sessions, 360 px wide" note="After the group's label and what it was last asked, at the session list's width at 1,200 px." width={360}>
        <Rows rows={acrossGroups(RUNNING_ROWS)} showGroup />
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
      <Specimen
        title="With ended sessions, and Show older (W67)"
        note="Ended interactive sessions from the last 7 days, muted, with Ended where a finished background session has its state, sorted with them. Those older than 7 days are behind Show older, an outline sm button after the rows, described by the line after it. Press it: they're listed after the rest, and it reads Hide older sessions, the same button, so focus stays on it. In the app it's one switch for the page, and isn't kept across reloads."
      >
        <Finished rows={inGroup('pitwall-test-app', ENDED_ROWS)} older={inGroup('pitwall-test-app', OLDER_ENDED_ROWS)} />
      </Specimen>
      <Specimen title="Show older on" note="The older ended sessions listed, last, and Hide older sessions in Show older's place.">
        <Finished rows={inGroup('pitwall-test-app', ENDED_ROWS)} older={inGroup('pitwall-test-app', OLDER_ENDED_ROWS)} olderShown />
      </Specimen>
      <Specimen title="With ended sessions, in All sessions" note="With each row's group label, and the count of every older one in the view.">
        <Finished rows={acrossGroups(ENDED_ROWS)} older={acrossGroups(OLDER_ENDED_ROWS)} showGroup />
      </Specimen>
      <Specimen
        title="Only older ended sessions"
        note="A group with other sessions, whose finished ones all ended more than 7 days ago: Finished (0), with Show older inside it. A group with nothing else isn't in the repo list until Show older is on."
      >
        <Finished rows={[]} older={inGroup('pitwall-test-app', OLDER_ENDED_ROWS)} />
      </Specimen>
      <Specimen title="With ended sessions, 375 px wide" note="The session list's width at 375 px. The line after Show older wraps under it when there's no room beside it." width={375}>
        <Finished rows={acrossGroups(ENDED_ROWS)} older={acrossGroups(OLDER_ENDED_ROWS)} showGroup />
      </Specimen>
    </>
  );
}
