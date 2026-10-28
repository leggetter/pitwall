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
  holdOrder,
  isRootGroup,
  listScope,
  matchesChips,
  matchRanges,
  needsAttention,
  NO_FILTERS,
  noMatchText,
  repoListGroups,
  rowStatusBadge,
  sessionCount,
  sessionsIn,
  SORT_LABELS,
  SORT_ORDERS,
  startGroup,
  startLabel,
  statusBadge,
  workedInLabels,
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
  it('lists a group in the index\'s order, its finished sessions apart', () => {
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
    // Every reason alike, by activity (W69): asked you was active most recently.
    expect(names(current)).toEqual(['asked', 'background-blocked', 'interactive-waiting']);
    expect(finished).toEqual([]);
  });

  it('lists only the starred sessions under Starred, from every group, each once, finished ones apart, in the order chosen (W53)', () => {
    const ids = new Set([SESSIONS['interactive-idle'].sessionId, SESSIONS['background-blocked'].sessionId, SESSIONS['background-finished'].sessionId, 'not-in-the-snapshot']);
    const { current, finished } = listScope([app, jobs], { kind: 'starred', ids });
    expect(names(current)).toEqual(['background-blocked', 'interactive-idle']);
    expect(names(finished)).toEqual(['background-finished']);
    expect(current.find(({ session: shown }) => shown.name === 'background-blocked')?.group).toBe(jobs);
    expect(names(listScope([app, jobs], { kind: 'starred', ids }, 'name').current)).toEqual(['background-blocked', 'interactive-idle']);
    expect(names(listScope([app, jobs], { kind: 'starred', ids }, 'recent').current)).toEqual(['interactive-idle', 'background-blocked']);
    expect(listScope([app, jobs], { kind: 'starred', ids: new Set() })).toEqual({ current: [], finished: [] });
  });

  it('sorts as the index does within a group, so a group listed alone and under All agree', () => {
    for (const listed of [app, jobs]) expect([...listed.sessions].sort(compareSessions)).toEqual(listed.sessions);
  });
});

describe('the Sort setting', () => {
  const at = (name: string, minutes: number, overrides: Partial<SessionSummary> = {}) => session({ name, lastActivityAt: minutesAgo(minutes), ...overrides });
  const sorting = group({
    sessions: [
      at('repo-10', 1),
      at('Beta', 30, { status: 'waiting' }),
      at('repo-2', 3, { askedYou: { reason: 'question', excerpt: 'Ship it?' } }),
      at('alpha', 2, { status: 'busy' }),
      at('stale-one', 0.5, { kind: 'background', shortId: 's1', status: undefined, state: 'blocked', stale: true }),
      at('done-new', 4, done),
      at('Done-old', 40, done),
      at('done-mid', 10, done),
    ],
  });
  const both = (order: Parameters<typeof listScope>[2]) => {
    const { current, finished } = listScope([sorting], { kind: 'group', group: sorting }, order);
    return { current: names(current), finished: names(finished) };
  };

  it('has Urgency, the default, then Recent and Name', () => {
    expect(SORT_ORDERS.map((order) => SORT_LABELS[order])).toEqual(['Urgency', 'Recent', 'Name']);
    expect(both(undefined)).toEqual(both('urgency'));
  });

  it("Urgency is the index's order: needs you, whatever the reason, busy, then by activity, stale after; finished ones by activity alone", () => {
    expect(both('urgency')).toEqual({
      current: ['repo-2', 'Beta', 'alpha', 'repo-10', 'stale-one'],
      finished: ['done-new', 'done-mid', 'Done-old'],
    });
  });

  it('Recent: most recently active first, finished ones too', () => {
    expect(both('recent')).toEqual({
      current: ['stale-one', 'repo-10', 'alpha', 'repo-2', 'Beta'],
      finished: ['done-new', 'done-mid', 'Done-old'],
    });
  });

  it('Name: alphanumerically, case-insensitively, numbers as numbers, finished ones too', () => {
    expect(both('name')).toEqual({
      current: ['alpha', 'Beta', 'repo-2', 'repo-10', 'stale-one'],
      finished: ['done-mid', 'done-new', 'Done-old'],
    });
  });

  it('applies to Needs you and All sessions as to a group', () => {
    expect(names(listScope([app, jobs], { kind: 'needs-you' }, 'name').current)).toEqual(['background-blocked', 'interactive-waiting']);
    expect(names(listScope([app, jobs], { kind: 'all' }, 'recent').current)).toEqual([
      'interactive-idle',
      'background-blocked',
      'background-working',
      'interactive-waiting',
    ]);
  });
});

describe('holdOrder, while the reader is in the list', () => {
  it('keeps the order shown when the new one only reorders', () => {
    expect(holdOrder(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual(['a', 'b', 'c']);
  });

  it('drops the rows that have gone at once', () => {
    expect(holdOrder(['a', 'b', 'c'], ['c', 'a'])).toEqual(['a', 'c']);
  });

  it('adds new rows at once, after the row they follow in the new order, or first', () => {
    expect(holdOrder(['a', 'b', 'c'], ['c', 'new', 'a', 'b'])).toEqual(['a', 'b', 'c', 'new']);
    expect(holdOrder(['a', 'b'], ['first', 'b', 'a'])).toEqual(['first', 'a', 'b']);
    expect(holdOrder(['a', 'b'], ['b', 'x', 'y', 'a'])).toEqual(['a', 'b', 'x', 'y']);
    expect(holdOrder([], ['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('needsAttention, with no idle badge in the list', () => {
  const asked = { reason: 'question' as const, excerpt: 'Ship it?' };

  /** A session for every combination of the fields its state and its badge come from. */
  function everySession(): SessionSummary[] {
    const all: SessionSummary[] = [];
    for (const status of ['waiting', 'busy', 'idle', undefined] as const)
      for (const state of [undefined, 'working', 'blocked', 'done', 'stopped', 'failed'] as const)
        for (const askedYou of [undefined, asked])
          for (const stale of [false, true])
            for (const finished of [false, true])
              for (const alive of [true, false])
                for (const kind of ['interactive', 'background'] as const)
                  all.push(session({ status, state, askedYou, stale, finished, alive, kind, shortId: kind === 'background' ? 'b1' : undefined }));
    return all;
  }

  it('comes from waiting, blocked and asked you, never from the badge', () => {
    for (const shown of everySession()) {
      const expected = !shown.stale && !shown.finished && (shown.status === 'waiting' || shown.state === 'blocked' || shown.askedYou !== undefined);
      expect(needsAttention(shown), JSON.stringify(shown)).toBe(expected);
    }
  });

  it('is false for every session whose badge the list leaves out, so leaving Idle out hides nobody who needs you', () => {
    const hidden = everySession().filter((shown) => rowStatusBadge(shown) === undefined);
    expect(hidden.length).toBeGreaterThan(0);
    expect(hidden.every((shown) => statusBadge(shown).status === 'idle')).toBe(true);
    expect(hidden.filter((shown) => needsAttention(shown))).toEqual([]);
  });

  it('counts an idle session that asked you, whose badge says Asked you', () => {
    const idleAsked = session({ status: 'idle', askedYou: asked });
    expect(needsAttention(idleAsked)).toBe(true);
    expect(rowStatusBadge(idleAsked)?.label).toBe('Asked you');
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

describe('each session in one group (W39)', () => {
  const ROOT = '/Users/example/code';
  const worked = (...keys: string[]) => keys.map((key, index) => ({ key: `${ROOT}/${key}`, label: key, root: ROOT, calls: 10, changes: 0, lastAt: minutesAgo(index) }));
  // As the index sends them: each session in the group it started in alone. docs has no group, since
  // no session started there.
  const inApp = session({ name: 'in-app', cwd: `${ROOT}/app`, status: 'waiting', workedIn: worked('api') });
  const fromRoot = session({ name: 'from-root', cwd: ROOT, workedIn: worked('docs', 'api') });
  const inNotes = session({ name: 'in-notes', cwd: `${ROOT}/notes`, workedIn: worked('docs') });
  const inApi = session({ name: 'in-api', cwd: `${ROOT}/api` });
  const app = group({ key: `${ROOT}/app`, label: 'app', sessions: [inApp] });
  const api = group({ key: `${ROOT}/api`, label: 'api', sessions: [inApi] });
  const notes = group({ key: `${ROOT}/notes`, label: 'notes', kind: 'directory', sessions: [inNotes] });
  const code = group({ key: ROOT, label: 'code', kind: 'directory', sessions: [fromRoot] });
  const groups = [api, app, notes, code];

  it('sessionsIn: every session, each once, in the groups’ order', () => {
    expect(sessionsIn(groups).map((s) => s.name)).toEqual(['in-api', 'in-app', 'in-notes', 'from-root']);
    expect(sessionsIn([])).toEqual([]);
  });

  it('startGroup and startLabel: the one group listing it, the root’s own as its path', () => {
    expect(startGroup(groups, inApp)).toBe(app);
    expect(startGroup(groups, inNotes)).toBe(notes);
    expect(startGroup(groups, fromRoot)).toBe(code);
    expect(startLabel(groups, inApp)).toBe('app');
    expect(startLabel(groups, fromRoot)).toBe('~/code');
  });

  it('startGroup and startLabel: none for a session the snapshot no longer lists, which is labelled by its directory', () => {
    const gone = session({ name: 'gone', cwd: `${ROOT}/app/src` });
    expect(startGroup(groups, gone)).toBeUndefined();
    expect(startLabel(groups, gone)).toBe('~/code/app/src');
  });

  it("workedInLabels: each repo's label, newest touch first, whether or not it has a group", () => {
    // docs has no group; api has one.
    expect(workedInLabels(fromRoot, [ROOT])).toEqual(['docs', 'api']);
    expect(workedInLabels(session({ name: 'none' }), [ROOT])).toEqual([]);
    // The labels come from the session, not the snapshot's groups, so they're the same with none.
    expect(workedInLabels(inNotes, [])).toEqual(['docs']);
  });

  it("workedInLabels: a repo that is itself a root shows the root's path, as the repo list does", () => {
    const other = '/Users/example/work';
    const nested = session({ name: 'nested', cwd: `${other}/vendor/lib`, workedIn: [{ key: other, label: 'work', root: other, calls: 5, changes: 1, lastAt: minutesAgo(1) }] });
    expect(workedInLabels(nested, [ROOT, other])).toEqual(['~/work']);
  });

  it('listScope: each session once, under the group it started in, in All sessions and Needs you', () => {
    const all = listScope(groups, { kind: 'all' });
    expect(all.current.map(({ session: s, group: g }) => [s.name, g.label]).sort()).toEqual([
      ['from-root', 'code'],
      ['in-api', 'api'],
      ['in-app', 'app'],
      ['in-notes', 'notes'],
    ]);
    expect(listScope(groups, { kind: 'needs-you' }).current.map(({ session: s }) => s.name)).toEqual(['in-app']);
  });

  it("listScope: a group's list is the sessions started in it, and none says it started elsewhere", () => {
    const listed = listScope(groups, { kind: 'group', group: api }).current;
    expect(names(listed)).toEqual(['in-api']);
    for (const item of listed) expect(Object.keys(item).sort()).toEqual(['group', 'session']);
  });

  it('filterListed: a repo a session worked in lets it through, as its own group does, with or without a group of its own', () => {
    const all = listScope(groups, { kind: 'all' }).current;
    // docs has no group: the sessions that worked there.
    expect(names(filterListed(all, filters('docs'))).sort()).toEqual(['from-root', 'in-notes']);
    // api has one: the session started there, and the two that worked there.
    expect(names(filterListed(all, filters('API'))).sort()).toEqual(['from-root', 'in-api', 'in-app']);
    expect(names(filterListed(all, filters('notes')))).toEqual(['in-notes']);
    // In a group's own list too.
    expect(names(filterListed(listScope(groups, { kind: 'group', group: app }).current, filters('api')))).toEqual(['in-app']);
    // And with the chips, which it ANDs with.
    expect(filterListed(all, filters('docs', ['background']))).toEqual([]);
  });
});
