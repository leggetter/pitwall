// Sessions and pull requests as one list of work (W106, work.ts): which session owns each open PR, a
// later session taking one over, a finished or ended session that owns one, where each PR no session
// owns is placed, those no root claims, Needs you through a PR, and how the rows sort and filter.
// Made-up sessions, repos and PRs only.

import { describe, expect, it } from 'vitest';
import type { PullRequestPlace, PullRequestSummary, SessionGroup } from '../../src/shared/protocol.js';
import { groupSessions } from './groupBy.js';
import { prKey } from './prs.js';
import { tabAttention } from './rootTabs.js';
import { isOlderEnded, withoutOlderEnded } from './sessions.js';
import { group, minutesAgo, NOW, pr, prLink, session } from './test/fixtures.js';
import {
  allDone,
  composeWork,
  countNeeds,
  countRows,
  filterRows,
  hiddenOwners,
  isDone,
  isNotClonedKey,
  isPrRow,
  listWork,
  matchesRelations,
  notClonedKey,
  ownerIds,
  ownsPr,
  prNeeding,
  prRowCounts,
  rowKey,
  rowOrder,
  sessionNeedsYou,
  withPrRows,
  type ListRow,
  type Work,
} from './work.js';

const ROOT = '/Users/example/code';
const DEMO = `${ROOT}/demo-app`;
const RELAY = `${ROOT}/event-relay`;
const DAY = 24 * 60;

const cloned = (key: string, label: string): PullRequestPlace => ({ kind: 'cloned', root: ROOT, key, label });
const notCloned: PullRequestPlace = { kind: 'not-cloned', root: ROOT };

/** A row's name on screen: a session's, or "#n" for a PR's. */
const named = (rows: readonly ListRow[]) => rows.map((row) => (isPrRow(row) ? `#${row.pr.number}` : row.session.name));

const ended = { ended: true, finished: true, alive: false, pid: undefined, status: undefined } as const;

describe('which session owns a PR', () => {
  const failing = pr({ number: 51, checks: 'failing' }, 10);
  const quiet = pr({ number: 48 }, 30);

  it('is the one that acted on it last: opened, pushed or linked; a prompt only when nothing acted; never a mention', () => {
    const opener = session({ name: 'opener', prLinks: [prLink('opened', failing, 40)] });
    const pusher = session({ name: 'pusher', prLinks: [prLink('pushed', failing, 20)] });
    const prompted = session({ name: 'prompted', prLinks: [prLink('prompted', failing, 1)] });
    const mentioner = session({ name: 'mentioner', prLinks: [prLink('mentioned', failing, 0)] });
    expect(composeWork([opener, pusher, prompted, mentioner], [failing]).ownerOf.get(prKey(failing))?.name).toBe('pusher');
    // With nothing that acted on it, a prompt owns it; a mention alone never does.
    expect(composeWork([prompted, mentioner], [failing]).ownerOf.get(prKey(failing))?.name).toBe('prompted');
    const nobody = composeWork([mentioner], [{ ...failing, place: notCloned }]);
    expect(nobody.ownerOf.size).toBe(0);
    expect(nobody.placed.map(({ pr: each }) => each.number)).toEqual([51]);
    // Claude Code's own link counts as acting on it.
    const linker = session({ name: 'linker', prLinks: [{ kind: 'linked', repo: failing.repo, number: 51, lastAt: minutesAgo(5) }] });
    expect(composeWork([pusher, linker], [failing]).ownerOf.get(prKey(failing))?.name).toBe('linker');
  });

  it('is taken over by a session acting on it later, and the one before keeps only its link', () => {
    const first = session({ name: 'first', prLinks: [prLink('opened', failing, 60), prLink('opened', quiet, 60)] });
    const later = session({ name: 'later', prLinks: [prLink('pushed', failing, 5)] });
    const work = composeWork([first, later], [failing, quiet]);
    expect(work.owned.get(later.sessionId)?.map((each) => each.number)).toEqual([51]);
    expect(work.owned.get(first.sessionId)?.map((each) => each.number)).toEqual([48]);
    expect([ownsPr(first, work), ownsPr(later, work)]).toEqual([true, true]);
  });

  it('lists what a session owns most urgent first, finished and ended sessions included', () => {
    const gone = session({ name: 'gone', ...ended, prLinks: [prLink('opened', quiet, 90), prLink('opened', failing, 80)] });
    const work = composeWork([gone], [quiet, failing]);
    expect(work.owned.get(gone.sessionId)?.map((each) => each.number)).toEqual([51, 48]);
    expect(ownerIds(work)).toEqual(new Set([gone.sessionId]));
  });

  it('has nothing to own with no PRs', () => {
    const work = composeWork([session({ prLinks: [prLink('opened', failing)] })], []);
    expect([work.owned.size, work.placed.length, work.hidden.length]).toEqual([0, 0, 0]);
  });
});

describe('a finished session that owns an open PR', () => {
  const open = pr({ number: 7 }, 10);
  const gone = session({ name: 'gone', ...ended, lastActivityAt: minutesAgo(20 * DAY), prLinks: [prLink('opened', open, 20 * DAY)] });
  const done = session({ name: 'done', ...ended, lastActivityAt: minutesAgo(DAY) });
  const live = session({ name: 'live' });
  const demo = group({ key: DEMO, sessions: [live, gone, done] });
  const work = composeWork([live, gone, done], [open]);

  it('is listed with the rest, not in Finished, until the PR closes', () => {
    expect([isDone(gone, work), isDone(done, work)]).toEqual([false, true]);
    const { current, finished } = listWork([demo], { kind: 'group', group: demo }, 'urgency', undefined, undefined, work);
    expect(named(current)).toEqual(['live', 'gone']);
    expect(named(finished)).toEqual(['done']);
    const closed = composeWork([live, gone, done], []);
    expect(named(listWork([demo], { kind: 'all' }, 'urgency', undefined, undefined, closed).finished)).toEqual(['done', 'gone']);
  });

  it('stays in the ended sessions’ window, however old, and a group of its finished work alone is no longer muted', () => {
    const now = NOW;
    expect(isOlderEnded(gone, now)).toBe(true);
    expect(withoutOlderEnded([demo], now, ownerIds(work))[0]?.sessions.map((each) => each.name)).toEqual(['live', 'gone', 'done']);
    expect(withoutOlderEnded([demo], now)[0]?.sessions.map((each) => each.name)).toEqual(['live', 'done']);
    const only = group({ key: DEMO, sessions: [gone] });
    expect([allDone(only, work), allDone(only, composeWork([gone], []))]).toEqual([false, true]);
  });
});

describe('where a PR no session owns is listed', () => {
  const owned = pr({ number: 1 }, 5);
  const inDemo = { ...pr({ number: 2 }, 10), place: cloned(DEMO, 'demo-app') };
  const inRelay = { ...pr({ number: 3, repoLabel: 'example/event-relay' }, 20), place: cloned(RELAY, 'event-relay') };
  const elsewhere = { ...pr({ number: 4, repoLabel: 'example/Docs-Site' }, 30), place: notCloned };
  const unclaimed = { ...pr({ number: 5, repoLabel: 'other-org/tool' }, 40), place: { kind: 'unclaimed' } as const };
  const noPlace = pr({ number: 6, repoLabel: 'third/thing' }, 50);
  const old = { ...pr({ number: 8 }, 120 * DAY), place: cloned(DEMO, 'demo-app') };
  const worker = session({ name: 'worker', prLinks: [prLink('opened', owned)] });
  const demo = group({ key: DEMO, sessions: [worker] });
  const prs = [owned, inDemo, inRelay, elsewhere, unclaimed, noPlace, old];
  const work = composeWork([worker], prs, { now: NOW });
  const groups = withPrRows([demo], work);

  it('is under the cloned repo’s group, which is built when no session is listed there; a not-cloned repo’s own; never the owned PR', () => {
    expect(groups.map((each) => [each.key, each.label, each.sessions.length, each.prs?.map((one) => one.number), each.notCloned ?? false])).toEqual([
      [DEMO, 'demo-app', 1, [2], false],
      [RELAY, 'event-relay', 0, [3], false],
      [notClonedKey('example/docs-site'), 'example/Docs-Site', 0, [4], true],
    ]);
    expect(groups[2]?.root).toBe(ROOT);
    expect([isNotClonedKey(groups[2]?.key ?? ''), isNotClonedKey(DEMO)]).toEqual([true, false]);
    // The snapshot's group isn't touched.
    expect('prs' in demo).toBe(false);
  });

  it('counts those no root claims, or with no place, and names their owners', () => {
    expect(work.hidden.map((each) => each.number)).toEqual([5, 6]);
    expect(hiddenOwners(work)).toEqual(['other-org', 'third']);
  });

  it('leaves out one not updated in PRS_SHOWN_DAYS, until Show older', () => {
    expect(work.older).toBe(1);
    const shown = composeWork([worker], prs, { now: NOW, showOlder: true });
    expect(shown.older).toBe(0);
    expect(withPrRows([demo], shown)[0]?.prs?.map((each) => each.number)).toEqual([2, 8]);
    // A now that isn't a time, as before the first fetch, hides nothing.
    expect(composeWork([worker], prs).older).toBe(0);
  });

  it('goes with its group into Main repo’s groups too, where the group is the mode’s', () => {
    const fromRoot = session({ name: 'from-root', cwd: ROOT, workedIn: [{ key: RELAY, label: 'event-relay', root: ROOT, calls: 10, changes: 4, lastAt: minutesAgo(1) }] });
    const rootGroup = group({ key: ROOT, label: 'code', kind: 'directory', sessions: [fromRoot] });
    const mode = groupSessions([rootGroup, demo], 'main-repo');
    const listed = withPrRows(mode.groups, work);
    const relay = listed.find((each) => each.key === RELAY);
    expect([relay?.sessions.map((each) => each.name), relay?.prs?.map((each) => each.number)]).toEqual([['from-root'], [3]]);
  });

  it('is a row in its group, All sessions and Pull requests; never Starred', () => {
    expect(named(listWork(groups, { kind: 'group', group: groups[1]! }, 'urgency', undefined, undefined, work).current)).toEqual(['#3']);
    expect(named(listWork(groups, { kind: 'all' }, 'recent', undefined, undefined, work).current)).toEqual(['worker', '#2', '#3', '#4']);
    expect(named(listWork(groups, { kind: 'starred', ids: new Set([worker.sessionId]) }, 'urgency', undefined, undefined, work).current)).toEqual(['worker']);
    expect([countRows(groups), countRows([groups[0]!])]).toEqual([4, 2]);
  });
});

describe('Needs you, through a PR', () => {
  const failing = pr({ number: 128, checks: 'failing' }, 10);
  const conflicts = { ...pr({ number: 9, mergeable: 'conflicts' }, 15), place: cloned(DEMO, 'demo-app') };
  const asked = { ...pr({ number: 57, relation: 'review-requested' }, 20), place: cloned(DEMO, 'demo-app') };
  const mention = { ...pr({ number: 23, relation: 'mentioned', checks: 'failing' }, 25), place: cloned(DEMO, 'demo-app') };
  const owner = session({ name: 'owner', prLinks: [prLink('opened', failing)] });
  const gone = session({ name: 'gone', ...ended, prLinks: [prLink('opened', failing, 20), prLink('pushed', { ...failing, number: 1 }, 200)] });
  const waiting = session({ name: 'waiting', status: 'waiting', waitingFor: 'permission prompt', lastActivityAt: minutesAgo(1) });
  const idle = session({ name: 'idle', lastActivityAt: minutesAgo(2) });
  const demo = group({ key: DEMO, sessions: [owner, waiting, idle] });
  const work = composeWork([owner, waiting, idle], [failing, conflicts, asked, mention]);
  const groups = withPrRows([demo], work);

  it('counts a session whose PR needs attention, and a PR row that does; never a mention', () => {
    expect([sessionNeedsYou(owner, undefined, work), sessionNeedsYou(idle, undefined, work), sessionNeedsYou(waiting, undefined, work)]).toEqual([true, false, true]);
    expect(prNeeding(owner, work)?.number).toBe(128);
    // owner, waiting, #9 and #57: not idle, nor the mention with its author's failing checks.
    expect(countNeeds(groups, undefined, work)).toBe(4);
    expect(tabAttention(groups, ROOT, undefined, work)).toBe(4);
    // Without who owns what, only the session that needs you itself and the PR rows the groups carry.
    expect(tabAttention(groups, ROOT)).toBe(3);
    expect(named(listWork(groups, { kind: 'needs-you' }, 'urgency', undefined, undefined, work).current)).toEqual(['waiting', 'owner', '#9', '#57']);
  });

  it('counts an ended session through its PR, and one marked not needed now still needs you through its PR', () => {
    const work2 = composeWork([gone], [failing]);
    expect(sessionNeedsYou(gone, undefined, work2)).toBe(true);
    const marked = new Map([[waiting.sessionId, 'x']]) as unknown as Parameters<typeof sessionNeedsYou>[1];
    const ownsAndWaits = session({ name: 'both', status: 'waiting', waitingFor: 'permission prompt', prLinks: [prLink('opened', failing)] });
    const work3 = composeWork([ownsAndWaits], [failing]);
    expect(sessionNeedsYou(ownsAndWaits, marked, work3)).toBe(true);
  });

  it('counts the Pull requests item: the rows with an open PR, and those that need you through one', () => {
    // owner and the three PR rows; owner, #9 and #57 need you through a PR, waiting doesn't count.
    expect(prRowCounts(groups, work)).toEqual({ count: 4, attention: 3 });
    expect(named(listWork(groups, { kind: 'prs' }, 'name', undefined, undefined, work).current)).toEqual(['owner', '#9', '#57', '#23']);
  });
});

describe('how the rows sort and filter', () => {
  const failing = { ...pr({ number: 3, title: 'Alpha change', checks: 'failing' }, 30), place: cloned(DEMO, 'demo-app') };
  const quiet = { ...pr({ number: 4, title: 'Zulu change' }, 1), place: cloned(DEMO, 'demo-app') };
  const ownedPr = pr({ number: 128, title: 'The health route', head: { repo: 'example/demo-app', branch: 'feat/health' } }, 50);
  const busy = session({ name: 'busy', status: 'busy', lastActivityAt: minutesAgo(10) });
  const idle = session({ name: 'idle', kind: 'background', shortId: 'b1', status: undefined, state: 'working', lastActivityAt: minutesAgo(5), prLinks: [prLink('opened', ownedPr)] });
  const stale = session({ name: 'stale', stale: true, lastActivityAt: minutesAgo(0.1) });
  const demo = group({ key: DEMO, sessions: [busy, idle, stale] });
  const work: Work = composeWork([busy, idle, stale], [failing, quiet, ownedPr]);
  const [groupOf] = withPrRows([demo], work);
  const rows = listWork([groupOf!], { kind: 'group', group: groupOf! }, 'urgency', undefined, undefined, work).current;

  it('sorts by Urgency as sessions do, a PR that needs you first, a PR row by its update, stale ones last', () => {
    expect(named(rows)).toEqual(['#3', 'busy', '#4', 'idle', 'stale']);
    expect(named([...rows].sort(rowOrder('recent', undefined, work)))).toEqual(['stale', '#4', 'idle', 'busy', '#3']);
    expect(named([...rows].sort(rowOrder('name', undefined, work)))).toEqual(['#3', 'busy', 'idle', 'stale', '#4']);
    expect(rowKey(rows[0]!)).toBe(`pr:${prKey(failing)}`);
  });

  it('keeps PR rows out of a kind chip, and Has PR keeps the rows with a PR', () => {
    const chips = (...on: ('interactive' | 'background' | 'has-pr')[]) => named(filterRows(rows, { text: '', chips: new Set(on) }, work));
    expect(chips('interactive')).toEqual(['busy', 'stale']);
    expect(chips('has-pr')).toEqual(['#3', '#4', 'idle']);
    expect(chips('has-pr', 'background')).toEqual(['idle']);
    expect(chips('has-pr', 'interactive')).toEqual([]);
  });

  it('finds a session by a PR it owns, and a PR row by its title, number, repo or group', () => {
    const text = (value: string) => named(filterRows(rows, { text: value, chips: new Set() }, work));
    expect(text('#128')).toEqual(['idle']);
    expect(text('feat/health')).toEqual(['idle']);
    expect(text('zulu')).toEqual(['#4']);
    expect(text('#3')).toEqual(['#3']);
    expect(text('demo-app')).toEqual(['#3', 'busy', '#4', 'idle', 'stale']);
  });

  it("matches W101's chips by a PR row's relation, or any PR a session owns", () => {
    expect(rows.filter((row) => matchesRelations(row, new Set(['authored']), work)).length).toBe(3);
    expect(rows.filter((row) => matchesRelations(row, new Set(['mentioned']), work)).length).toBe(0);
    expect(rows.filter((row) => matchesRelations(row, new Set(), work)).length).toBe(5);
  });
});

describe('a group the page builds for PR rows', () => {
  it('is a git repo under the place’s root, and a not-cloned one only while it has PR rows', () => {
    const elsewhere = { ...pr({ number: 1, repoLabel: 'example/Tool' }), place: notCloned } satisfies PullRequestSummary;
    const groups: SessionGroup[] = [];
    expect(withPrRows(groups, composeWork([], [elsewhere]))).toMatchObject([{ key: 'github.com/example/tool', label: 'example/Tool', kind: 'git', root: ROOT, notCloned: true }]);
    expect(withPrRows(groups, composeWork([], []))).toEqual([]);
  });
});
