// The repo list's order and the session list's contents (docs/design-system.md, 3), and the filters
// (Filter chips): the Interactive and Background chips combine as OR, no chip on lets everything
// through, and the text ANDs with them.
import { describe, expect, it } from 'vitest';
import type { SessionGroup, SessionSummary } from '../../src/shared/protocol.js';
import {
  allFinished,
  compareSessions,
  FILTER_CHIPS,
  filtering,
  filterListed,
  filterNeedle,
  groupLabel,
  isRootGroup,
  listScope,
  matchesChips,
  matchRanges,
  NO_FILTERS,
  noMatchText,
  repoListGroups,
  sessionCount,
  type FilterChip,
  type Filters,
  type Listed,
} from './sessions.js';
import { group, minutesAgo, session } from './test/fixtures.js';

const done = { kind: 'background', alive: false, pid: undefined, status: undefined, state: 'done', finished: true } as const;

/** One session of each kind, and of the states the views tell apart, named after it. */
const SESSIONS = {
  'interactive-waiting': session({ name: 'interactive-waiting', status: 'waiting', waitingFor: 'permission prompt', lastActivityAt: minutesAgo(9) }),
  'interactive-idle': session({ name: 'interactive-idle', lastActivityAt: minutesAgo(1) }),
  'background-blocked': session({ name: 'background-blocked', kind: 'background', shortId: 'b1', status: undefined, state: 'blocked', lastActivityAt: minutesAgo(2) }),
  'background-working': session({ name: 'background-working', kind: 'background', shortId: 'b2', status: undefined, state: 'working', lastActivityAt: minutesAgo(3) }),
  'background-finished': session({ name: 'background-finished', ...done, shortId: 'b4', lastActivityAt: minutesAgo(4) }),
} satisfies Record<string, SessionSummary>;

type Name = keyof typeof SESSIONS;
const ALL = Object.keys(SESSIONS) as Name[];

/** The sessions that pass these chips, by name, in the order above. */
function passing(...chips: FilterChip[]): Name[] {
  return ALL.filter((name) => matchesChips(SESSIONS[name], new Set(chips)));
}

const filters = (text: string, chips: FilterChip[] = []): Filters => ({ text, chips: new Set(chips) });
const names = (listed: readonly Listed[]) => listed.map(({ session: shown }) => shown.name);

describe('the filter chips', () => {
  it('are Interactive and Background, in that order', () => {
    expect(FILTER_CHIPS).toEqual(['interactive', 'background']);
  });

  it('let everything through when none is on', () => {
    expect(passing()).toEqual(ALL);
  });

  it('Interactive: interactive sessions only', () => {
    expect(passing('interactive')).toEqual(['interactive-waiting', 'interactive-idle']);
  });

  it('Background: background sessions only, finished ones too', () => {
    expect(passing('background')).toEqual(['background-blocked', 'background-working', 'background-finished']);
  });

  it('Interactive or Background, with both on: everything, as with neither', () => {
    expect(passing('interactive', 'background')).toEqual(ALL);
  });
});

const ROOT = '/Users/example/code';
const app = group({ sessions: [SESSIONS['interactive-waiting'], SESSIONS['interactive-idle'], SESSIONS['background-finished']] });
const jobs = group({
  key: `${ROOT}/jobs`,
  label: 'jobs',
  sessions: [SESSIONS['background-blocked'], SESSIONS['background-working']],
});

describe('listScope', () => {
  it('lists a group in the order given, its finished sessions apart', () => {
    const { current, finished } = listScope([app, jobs], { kind: 'group', group: app });
    expect(names(current)).toEqual(['interactive-waiting', 'interactive-idle']);
    expect(names(finished)).toEqual(['background-finished']);
    expect(current.every(({ group: shown }) => shown === app)).toBe(true);
  });

  it('lists every group under All sessions in the index\'s order: waiting or blocked first, then by activity, finished apart', () => {
    const { current, finished } = listScope([app, jobs], { kind: 'all' });
    // Blocked was active 2 minutes ago, waiting 9: both need you, so the newer comes first.
    expect(names(current)).toEqual(['background-blocked', 'interactive-waiting', 'interactive-idle', 'background-working']);
    expect(names(finished)).toEqual(['background-finished']);
    expect(current.find(({ session: shown }) => shown.name === 'background-blocked')?.group).toBe(jobs);
  });

  it('lists only what needs you under Needs you, from every group, with no finished section', () => {
    const asked = session({ name: 'asked', askedYou: { reason: 'question', excerpt: 'Ship it?' }, lastActivityAt: minutesAgo(0.5) });
    const stale = session({ name: 'stale', kind: 'background', shortId: 'b9', status: undefined, state: 'blocked', stale: true });
    const finishedAsked = session({ name: 'finished-asked', ...done, shortId: 'b8', askedYou: { reason: 'question', excerpt: 'PR?' } });
    const more = group({ key: `${ROOT}/more`, label: 'more', sessions: [asked, stale, finishedAsked] });
    const { current, finished } = listScope([app, jobs, more], { kind: 'needs-you' });
    // Waiting and blocked before asked you, however recent.
    expect(names(current)).toEqual(['background-blocked', 'interactive-waiting', 'asked']);
    expect(finished).toEqual([]);
  });

  it('sorts as the index does within a group, so a group listed alone and under All agree', () => {
    for (const listed of [app, jobs]) expect([...listed.sessions].sort(compareSessions)).toEqual(listed.sessions);
  });
});

describe('filterListed', () => {
  const all = [...listScope([app, jobs], { kind: 'all' }).current, ...listScope([app, jobs], { kind: 'all' }).finished];

  it('keeps everything with no filters', () => {
    expect(filterListed(all, NO_FILTERS)).toEqual(all);
  });

  it('ANDs a chip with the text', () => {
    expect(names(filterListed(all, filters('finished', ['background'])))).toEqual(['background-finished']);
    expect(names(filterListed(all, filters('idle', ['background'])))).toEqual([]);
    expect(names(filterListed(all, filters('', ['interactive'])))).toEqual(['interactive-waiting', 'interactive-idle']);
  });

  it('matches names, titles and cwds case-insensitively, and lets a group whose label matches through whole', () => {
    expect(names(filterListed(all, filters(' WAITING ')))).toEqual(['interactive-waiting']);
    expect(names(filterListed(all, filters('JOBS')))).toEqual(['background-blocked', 'background-working']);
    expect(names(filterListed(all, filters('jobs', ['interactive'])))).toEqual([]);
  });
});

describe('the repo list', () => {
  const at = (root: string, label: string, overrides: Partial<SessionGroup> = {}) =>
    group({ root, key: `${root}/${label}`, label, sessions: [session({ name: `in-${label}` })], ...overrides });

  it('sorts each root\'s groups alphanumerically by label, case-insensitively, numbers as numbers, the root\'s own directory first', () => {
    const own = group({ root: ROOT, key: ROOT, label: 'code', sessions: [session({ name: 'in-root' })] });
    const groups = [at(ROOT, 'repo-10'), at(ROOT, 'api-server'), own, at(ROOT, 'repo-2'), at(ROOT, 'Api'), at(ROOT, 'zebra')];

    const [only] = repoListGroups(groups, [ROOT]);
    expect(only?.groups.map(groupLabel)).toEqual(['~/code', 'Api', 'api-server', 'repo-2', 'repo-10', 'zebra']);
  });

  it('keeps a group whose sessions have all finished in its place, and never sorts by activity', () => {
    const finishedOnly = at(ROOT, 'b-finished', { sessions: [session({ name: 'f', ...done, shortId: 'f1' })] });
    const busy = at(ROOT, 'c-busy', { sessions: [session({ name: 'busy', status: 'busy', lastActivityAt: minutesAgo(0) })] });
    const [only] = repoListGroups([busy, finishedOnly, at(ROOT, 'a-old')], [ROOT]);

    expect(only?.groups.map((shown) => shown.label)).toEqual(['a-old', 'b-finished', 'c-busy']);
    expect(only?.groups.map(allFinished)).toEqual([false, true, false]);
  });

  it('lists roots in the order pitwall was given them, leaving out roots with no groups', () => {
    const work = '/Users/example/work';
    const empty = '/Users/example/empty';
    const result = repoListGroups([at(work, 'b'), at(ROOT, 'z'), at(work, 'a'), at(ROOT, 'y')], [ROOT, empty, work]);

    expect(result.map(({ root, groups: listed }) => [root, listed.map((shown) => shown.label)])).toEqual([
      [ROOT, ['y', 'z']],
      [work, ['a', 'b']],
    ]);
  });

  it('labels the root\'s own directory with its path, home as ~, and other groups with their label', () => {
    const own = group({ root: ROOT, key: `${ROOT}/`, label: 'code', sessions: [] });
    expect(isRootGroup(own)).toBe(true);
    expect(groupLabel(own)).toBe('~/code');
    expect(groupLabel(at(ROOT, 'pitwall'))).toBe('pitwall');
    expect(isRootGroup(at(ROOT, 'pitwall'))).toBe(false);
    expect(allFinished(own)).toBe(false);
  });
});

describe('filtering', () => {
  it('is on with any text in the field or a chip, which is when Clear filters shows', () => {
    expect(filtering(NO_FILTERS)).toBe(false);
    expect(filtering(filters('', ['background']))).toBe(true);
    expect(filtering(filters('x'))).toBe(true);
    expect(filtering(filters(' '))).toBe(true);
  });
});

describe('noMatchText', () => {
  it('names the selection, the text, and whether chips are on', () => {
    expect(noMatchText(filters('zzz'), 'pitwall')).toEqual({ title: 'No sessions match', sentence: 'Nothing in pitwall matches "zzz".' });
    expect(noMatchText(filters(' zzz ', ['background']), 'All sessions')).toEqual({
      title: 'No sessions match',
      sentence: 'Nothing in All sessions matches "zzz" with these filters.',
    });
    expect(noMatchText(filters('', ['interactive']), 'Needs you').sentence).toBe('Nothing in Needs you matches these filters.');
  });
});

describe('matchRanges, for the highlight', () => {
  it('finds every match, case-insensitively, without overlaps', () => {
    expect(matchRanges('Export the exports', filterNeedle(' EXPORT '))).toEqual([
      [0, 6],
      [11, 17],
    ]);
    expect(matchRanges('aaaa', 'aa')).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });

  it('finds nothing for no text, or text that is not there', () => {
    expect(matchRanges('pitwall', '')).toEqual([]);
    expect(matchRanges('pitwall', 'zzz')).toEqual([]);
  });

  it('gives up rather than misplace a match when lower-casing changes the length', () => {
    expect(matchRanges('İstanbul export', 'export')).toEqual([]);
  });
});

describe('sessionCount', () => {
  it('handles one and many', () => {
    expect(sessionCount(1)).toBe('1 session');
    expect(sessionCount(12)).toBe('12 sessions');
    expect(sessionCount(0)).toBe('0 sessions');
  });
});
