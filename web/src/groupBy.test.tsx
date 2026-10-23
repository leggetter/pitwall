// Preferences' Group sessions by (W42): each mode's groups from the snapshot's, the main repo's
// tie-breaks, the home group each row names, and the stored mode with groupState.ts's failure
// handling. Made-up sessions and paths only.

import { describe, expect, it } from 'vitest';
import type { SessionGroup, WorkedIn } from '../../src/shared/protocol.js';
import {
  DEFAULT_GROUP_BY,
  everyGroupId,
  GROUP_BY_KEY,
  groupByPhrase,
  groupSessions,
  isRootStart,
  mainRepo,
  readGroupBy,
  writeGroupBy,
  type GroupBy,
} from './groupBy.js';
import type { StorageSource } from './groupState.js';
import { groupId, listScope, sessionsIn } from './sessions.js';
import { group, minutesAgo, session } from './test/fixtures.js';

const WORK = '/Users/example/work';
const PERSONAL = '/Users/example/personal';
const at = (root: string, name: string) => `${root}/${name}`;

/** A repo a session worked in, under `root`. */
const repo = (root: string, name: string, changes: number, calls: number, minutes = 1): WorkedIn => ({
  key: at(root, name),
  label: name,
  root,
  calls,
  changes,
  lastAt: minutesAgo(minutes),
});

/**
 * Two roots, as the index sends them: each session in the group it started in alone (W39).
 * - `big` started in ~/work itself and worked most in evals, which has no group, and less in blog,
 *   under ~/personal.
 * - `small` started in ~/work itself and worked in api alone.
 * - `alone` started in ~/work itself and worked in no repo.
 * - `inApi` started in api and worked in evals: a repo-started session, which never moves.
 * - `inNotes` started in a directory below ~/work and worked in evals: it never moves either.
 * - `inBlog` started in blog.
 */
function fixture() {
  const big = session({ name: 'big', cwd: WORK, status: 'waiting', waitingFor: 'permission prompt', workedIn: [repo(PERSONAL, 'blog', 5, 40, 2), repo(WORK, 'evals', 183, 1642, 1)] });
  const small = session({ name: 'small', cwd: WORK, workedIn: [repo(WORK, 'api', 1, 10)] });
  const alone = session({ name: 'alone', cwd: WORK });
  const inApi = session({ name: 'in-api', cwd: at(WORK, 'api'), askedYou: { reason: 'question', excerpt: 'Keep the made-up flag?' }, workedIn: [repo(WORK, 'evals', 9, 90)] });
  const inNotes = session({ name: 'in-notes', cwd: at(WORK, 'notes'), workedIn: [repo(WORK, 'evals', 2, 20)] });
  const inBlog = session({ name: 'in-blog', cwd: at(PERSONAL, 'blog') });
  const groups: SessionGroup[] = [
    group({ key: WORK, label: 'work', kind: 'directory', root: WORK, sessions: [big, small, alone] }),
    group({ key: at(WORK, 'api'), label: 'api', root: WORK, sessions: [inApi] }),
    group({ key: at(WORK, 'notes'), label: 'notes', kind: 'directory', root: WORK, sessions: [inNotes] }),
    group({ key: at(PERSONAL, 'blog'), label: 'blog', root: PERSONAL, sessions: [inBlog] }),
  ];
  return { groups, big, small, alone, inApi, inNotes, inBlog };
}

/** label (root's basename): session names, sorted, for every group. */
const placement = (groups: readonly SessionGroup[]) =>
  Object.fromEntries(groups.map((g) => [`${g.label} (${g.root.split('/').pop()})`, g.sessions.map((s) => s.name).sort()]));

/** Each session's home group, as label (root's basename). */
const homes = (fx: ReturnType<typeof fixture>, mode: GroupBy) => {
  const { home } = groupSessions(fx.groups, mode);
  return Object.fromEntries(sessionsIn(fx.groups).map((s) => [s.name, `${home.get(s.sessionId)?.label} (${home.get(s.sessionId)?.root.split('/').pop()})`]));
};

describe('mainRepo', () => {
  it('is the repo with the most changes, ties broken by tool calls, then the newest touch, then the path', () => {
    // Changes first, whatever the calls.
    expect(mainRepo([repo(WORK, 'a', 1, 900), repo(WORK, 'b', 2, 1)])?.label).toBe('b');
    // Equal changes: the most tool calls.
    expect(mainRepo([repo(WORK, 'a', 2, 10), repo(WORK, 'b', 2, 30)])?.label).toBe('b');
    // Equal changes and calls: the newest touch.
    expect(mainRepo([repo(WORK, 'a', 2, 30, 9), repo(WORK, 'b', 2, 30, 3)])?.label).toBe('b');
    // All equal: the path, first in order, whichever comes first in the list.
    expect(mainRepo([repo(WORK, 'b', 2, 30, 3), repo(WORK, 'a', 2, 30, 3)])?.label).toBe('a');
    expect(mainRepo([repo(WORK, 'a', 2, 30, 3), repo(WORK, 'b', 2, 30, 3)])?.label).toBe('a');
    expect(mainRepo([])).toBeUndefined();
  });

  it('compares the time of the newest touch, not its text', () => {
    // 12:30 UTC, after 13:00 at UTC+1, which is 12:00 UTC, though its text sorts first.
    const later = { ...repo(WORK, 'a', 1, 1), lastAt: '2026-03-02T12:30:00.000Z' };
    const sooner = { ...repo(WORK, 'b', 1, 1), lastAt: '2026-03-02T13:00:00.000+01:00' };
    expect(mainRepo([sooner, later])?.label).toBe('a');
  });
});

describe('isRootStart', () => {
  it("is a root's own directory, not a repo, nor a root that is itself a repo", () => {
    expect(isRootStart({ key: WORK, root: WORK, kind: 'directory' })).toBe(true);
    expect(isRootStart({ key: `${WORK}/`, root: WORK, kind: 'directory' })).toBe(true);
    expect(isRootStart({ key: at(WORK, 'notes'), root: WORK, kind: 'directory' })).toBe(false);
    expect(isRootStart({ key: WORK, root: WORK, kind: 'git' })).toBe(false);
  });
});

describe('groupSessions: Main repo, the default', () => {
  it('is the default', () => {
    expect(DEFAULT_GROUP_BY).toBe('main-repo');
  });

  it('moves a session started in a root itself to its main repo, and leaves every other session where it started', () => {
    const fx = fixture();
    expect(placement(groupSessions(fx.groups, 'main-repo').groups)).toEqual({
      // The root's own group keeps only the root-started session that worked in no repo.
      'work (work)': ['alone'],
      // small moved to api, its only repo; in-api, started there, stays.
      'api (work)': ['in-api', 'small'],
      // A directory below the root isn't the root itself: in-notes stays, though it worked in evals.
      'notes (work)': ['in-notes'],
      'blog (personal)': ['in-blog'],
      // big's main repo is evals, which has no group in the snapshot: one is built for it.
      'evals (work)': ['big'],
    });
  });

  it('builds a group for a repo with no snapshot group from the WorkedIn: its key, label and root, kind git', () => {
    const fx = fixture();
    const evals = groupSessions(fx.groups, 'main-repo').groups.find((g) => g.key === at(WORK, 'evals'));
    expect(evals).toEqual({ key: at(WORK, 'evals'), label: 'evals', kind: 'git', root: WORK, sessions: [fx.big] });
  });

  it('never moves a repo-started session, whatever it worked in', () => {
    const fx = fixture();
    const { groups } = groupSessions(fx.groups, 'main-repo');
    expect(groups.find((g) => g.key === at(WORK, 'api'))?.sessions).toContain(fx.inApi);
    expect(groups.filter((g) => g.sessions.includes(fx.inApi))).toHaveLength(1);
  });

  it("keeps a root-started session that worked in no repo in the root's own group", () => {
    const fx = fixture();
    const { groups, home } = groupSessions(fx.groups, 'main-repo');
    expect(groups.find((g) => g.key === WORK)?.sessions).toEqual([fx.alone]);
    expect(home.get(fx.alone.sessionId)?.key).toBe(WORK);
  });

  it("moves a session whose main repo is under another root to that root, and so to that root's tab", () => {
    const fx = fixture();
    // Worked most in blog, under ~/personal, this time.
    const crossing = session({ name: 'crossing', cwd: WORK, workedIn: [repo(WORK, 'api', 1, 5), repo(PERSONAL, 'blog', 4, 5)] });
    const groups = fx.groups.map((g) => (g.key === WORK ? { ...g, sessions: [...g.sessions, crossing] } : g));
    const result = groupSessions(groups, 'main-repo');
    const blog = result.groups.find((g) => g.key === at(PERSONAL, 'blog'));
    expect(blog?.root).toBe(PERSONAL);
    expect(blog?.sessions.map((s) => s.name).sort()).toEqual(['crossing', 'in-blog']);
    expect(result.home.get(crossing.sessionId)).toBe(blog);
    expect(result.groups.filter((g) => g.root === WORK).flatMap((g) => g.sessions)).not.toContain(crossing);
  });

  it('lists each session in one group, so the counts add up to All sessions', () => {
    const fx = fixture();
    const { groups } = groupSessions(fx.groups, 'main-repo');
    expect(groups.reduce((sum, g) => sum + g.sessions.length, 0)).toBe(sessionsIn(fx.groups).length);
  });

  it("drops the root's own group once every session started there has moved", () => {
    const fx = fixture();
    const groups = fx.groups.map((g) => (g.key === WORK ? { ...g, sessions: [fx.big, fx.small] } : g));
    expect(groupSessions(groups, 'main-repo').groups.some((g) => g.key === WORK)).toBe(false);
  });

  it('keeps the snapshot’s groups in its order, with built groups after them, and sorts each by urgency', () => {
    const fx = fixture();
    const { groups } = groupSessions(fx.groups, 'main-repo');
    expect(groups.map((g) => g.label)).toEqual(['work', 'api', 'notes', 'blog', 'evals']);
    // api: in-api asked you, so it's before small.
    expect(groups.find((g) => g.label === 'api')?.sessions.map((s) => s.name)).toEqual(['in-api', 'small']);
  });

  it("leaves the snapshot's groups as they were", () => {
    const fx = fixture();
    const before = JSON.stringify(fx.groups);
    groupSessions(fx.groups, 'main-repo');
    groupSessions(fx.groups, 'every-repo');
    expect(JSON.stringify(fx.groups)).toBe(before);
  });

  it('gives each session a home group that lists it: the group it is in', () => {
    const fx = fixture();
    expect(homes(fx, 'main-repo')).toEqual({
      big: 'evals (work)',
      small: 'api (work)',
      alone: 'work (work)',
      'in-api': 'api (work)',
      'in-notes': 'notes (work)',
      'in-blog': 'blog (personal)',
    });
  });

  it("keeps a root that is itself a repo a repo like any other: its sessions stay", () => {
    const inRepoRoot = session({ name: 'in-repo-root', cwd: WORK, workedIn: [repo(PERSONAL, 'blog', 9, 9)] });
    const groups = [group({ key: WORK, label: 'work', kind: 'git', root: WORK, sessions: [inRepoRoot] })];
    expect(placement(groupSessions(groups, 'main-repo').groups)).toEqual({ 'work (work)': ['in-repo-root'] });
  });
});

describe('groupSessions: a worked-in repo with no root', () => {
  it('is left out, so its session stays where it started and nothing throws, as from a server before W42', () => {
    const old = { key: at(WORK, 'evals'), label: 'evals', calls: 9, changes: 9, lastAt: minutesAgo(1) } as unknown as WorkedIn;
    const fromRoot = session({ name: 'from-root', cwd: WORK, workedIn: [old] });
    const groups = [group({ key: WORK, label: 'work', kind: 'directory', root: WORK, sessions: [fromRoot] })];
    for (const mode of ['main-repo', 'every-repo'] as const) {
      expect(placement(groupSessions(groups, mode).groups), mode).toEqual({ 'work (work)': ['from-root'] });
    }
    expect([...everyGroupId(groups)]).toEqual([groupId(groups[0] as SessionGroup)]);
  });
});

describe('groupSessions: Where it started', () => {
  it('is the snapshot’s groups exactly, each session’s home the group it started in', () => {
    const fx = fixture();
    const { groups, home } = groupSessions(fx.groups, 'where-started');
    expect(groups).toBe(fx.groups);
    for (const g of fx.groups) for (const s of g.sessions) expect(home.get(s.sessionId)).toBe(g);
  });
});

describe('groupSessions: Every repo it worked in', () => {
  it("lists each session where it started and under every repo it worked in, the root's own group only those that worked in none (W34)", () => {
    const fx = fixture();
    expect(placement(groupSessions(fx.groups, 'every-repo').groups)).toEqual({
      'work (work)': ['alone'],
      'api (work)': ['in-api', 'small'],
      'notes (work)': ['in-notes'],
      // big worked in blog too, under the other root.
      'blog (personal)': ['big', 'in-blog'],
      // Built: evals has no group in the snapshot. big, in-api and in-notes worked there.
      'evals (work)': ['big', 'in-api', 'in-notes'],
    });
  });

  it('counts each group’s distinct sessions, so the counts can add up to more than All sessions', () => {
    const fx = fixture();
    const { groups } = groupSessions(fx.groups, 'every-repo');
    const sum = groups.reduce((total, g) => total + g.sessions.length, 0);
    expect(sum).toBe(9);
    expect(sessionsIn(groups)).toHaveLength(6);
    for (const g of groups) expect(new Set(g.sessions.map((s) => s.sessionId)).size).toBe(g.sessions.length);
  });

  it('lists a session once in a group, though its workedIn names the repo twice', () => {
    const twice = session({ name: 'twice', cwd: at(WORK, 'api'), workedIn: [repo(WORK, 'evals', 1, 1), repo(WORK, 'evals', 1, 1)] });
    const groups = [group({ key: at(WORK, 'api'), label: 'api', root: WORK, sessions: [twice] })];
    expect(groupSessions(groups, 'every-repo').groups.find((g) => g.label === 'evals')?.sessions).toEqual([twice]);
  });

  it('gives each session a home: where it started, or a root-started session’s main repo', () => {
    const fx = fixture();
    expect(homes(fx, 'every-repo')).toEqual({
      big: 'evals (work)',
      small: 'api (work)',
      alone: 'work (work)',
      'in-api': 'api (work)',
      'in-notes': 'notes (work)',
      'in-blog': 'blog (personal)',
    });
  });

  it('lists each session once in All sessions and Needs you, under its home group', () => {
    const fx = fixture();
    const grouped = groupSessions(fx.groups, 'every-repo');
    const all = listScope(grouped.groups, { kind: 'all' }, 'name', grouped.home);
    expect(all.current.map(({ session: s, group: g }) => [s.name, g.label])).toEqual([
      ['alone', 'work'],
      ['big', 'evals'],
      ['in-api', 'api'],
      ['in-blog', 'blog'],
      ['in-notes', 'notes'],
      ['small', 'api'],
    ]);
    const needsYou = listScope(grouped.groups, { kind: 'needs-you' }, 'urgency', grouped.home);
    expect(needsYou.current.map(({ session: s }) => s.name)).toEqual(['big', 'in-api']);
  });
});

describe('everyGroupId', () => {
  it("names every group any mode can list: the snapshot's, and each repo a session worked in", () => {
    const fx = fixture();
    const ids = everyGroupId(fx.groups);
    for (const mode of ['main-repo', 'where-started', 'every-repo'] as const) {
      for (const g of groupSessions(fx.groups, mode).groups) expect(ids.has(groupId(g)), `${mode}: ${g.label}`).toBe(true);
    }
    expect(ids.has(groupId({ root: WORK, key: WORK }))).toBe(true);
  });
});

describe('the stored mode, pitwall.group-by.v1', () => {
  const store = (entries: Record<string, string> = {}) => {
    const values = new Map(Object.entries(entries));
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
    return Object.assign((() => storage) as StorageSource, { values });
  };

  it('reads each mode as written', () => {
    for (const mode of ['main-repo', 'where-started', 'every-repo'] as const) expect(readGroupBy(store({ [GROUP_BY_KEY]: mode }))).toBe(mode);
  });

  it('is Main repo when nothing is stored, storage is missing, it throws, or the value is anything else', () => {
    expect(readGroupBy(store())).toBe('main-repo');
    expect(readGroupBy(() => undefined)).toBe('main-repo');
    expect(readGroupBy(() => null)).toBe('main-repo');
    expect(
      readGroupBy(() => {
        throw new Error('blocked');
      }),
    ).toBe('main-repo');
    expect(
      readGroupBy(() => ({
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {},
      })),
    ).toBe('main-repo');
    for (const bad of ['', 'Main repo', 'MAIN-REPO', '"main-repo"', '{"mode":"every-repo"}', 'started', 'every']) expect(readGroupBy(store({ [GROUP_BY_KEY]: bad })), bad).toBe('main-repo');
  });

  it('writes the mode alone, under its key, and a failing write throws nothing', () => {
    const storage = store();
    writeGroupBy('every-repo', storage);
    expect([...storage.values]).toEqual([[GROUP_BY_KEY, 'every-repo']]);
    expect(() =>
      writeGroupBy('main-repo', () => ({
        getItem: () => null,
        setItem: () => {
          throw new Error('full');
        },
      })),
    ).not.toThrow();
    expect(() =>
      writeGroupBy('main-repo', () => {
        throw new Error('blocked');
      }),
    ).not.toThrow();
  });

  it('is a pitwall.*.v1 key', () => {
    expect(GROUP_BY_KEY).toMatch(/^pitwall\.[a-z-]+\.v1$/);
  });
});

describe('groupByPhrase', () => {
  it('reads after "grouped by"', () => {
    expect(groupByPhrase('main-repo')).toBe('main repo');
    expect(groupByPhrase('where-started')).toBe('where it started');
    expect(groupByPhrase('every-repo')).toBe('every repo it worked in');
  });
});
