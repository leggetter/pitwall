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
  elsewhereRepos,
  mainRepo,
  readGroupBy,
  writeGroupBy,
  type GroupBy,
} from './groupBy.js';
import type { StorageSource } from './groupState.js';
import { keepsOpenSession, selectionShowing } from './selection.js';
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
 * - `inNotes` started in a directory below ~/work that's in no repo and worked in evals alone, as a
 *   session that clones a repo there and works in it does: Main repo moves it to evals (W145).
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

describe('elsewhereRepos (W149)', () => {
  it("is the repos under another root than the group's, most changed first, each once, placeable only", () => {
    const old = { key: at(PERSONAL, 'old'), label: 'old', calls: 9, changes: 99, lastAt: minutesAgo(1) } as unknown as WorkedIn;
    const s = session({ cwd: WORK, workedIn: [repo(PERSONAL, 'blog', 1, 9), repo(WORK, 'api', 50, 50), repo(PERSONAL, 'skills', 4, 4), repo(PERSONAL, 'blog', 1, 9), old] });
    expect(elsewhereRepos(s, { root: WORK }).map((r) => r.label)).toEqual(['skills', 'blog']);
    expect(elsewhereRepos(s, { root: `${WORK}/` }).map((r) => r.label)).toEqual(['skills', 'blog']);
    expect(elsewhereRepos(s, { root: PERSONAL }).map((r) => r.label)).toEqual(['api']);
    expect(elsewhereRepos(session({ cwd: WORK }), { root: WORK })).toEqual([]);
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

  it('moves a session started in a root itself to its main repo, one started in a directory in no repo to its one repo, and leaves the rest where they started', () => {
    const fx = fixture();
    expect(placement(groupSessions(fx.groups, 'main-repo').groups)).toEqual({
      // The root's own group keeps only the root-started session that worked in no repo.
      'work (work)': ['alone'],
      // small moved to api, its only repo; in-api, started there, stays.
      'api (work)': ['in-api', 'small'],
      'blog (personal)': ['in-blog'],
      // big's main repo is evals, which has no group in the snapshot: one is built for it. in-notes
      // started in a directory in no repo and worked in evals alone, so it's there too, and notes,
      // with no session left, is left out.
      'evals (work)': ['big', 'in-notes'],
    });
  });

  it('builds a group for a repo with no snapshot group from the WorkedIn: its key, label and root, kind git', () => {
    const fx = fixture();
    const evals = groupSessions(fx.groups, 'main-repo').groups.find((g) => g.key === at(WORK, 'evals'));
    expect(evals).toEqual({ key: at(WORK, 'evals'), label: 'evals', kind: 'git', root: WORK, sessions: [fx.big, fx.inNotes] });
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

  it("keeps a session in the root it started in: its main repo there, though it changed another root's repo more (W149)", () => {
    const fx = fixture();
    // Worked most in blog, under ~/personal, this time, and a little in api, under ~/work.
    const crossing = session({ name: 'crossing', cwd: WORK, workedIn: [repo(WORK, 'api', 1, 5), repo(PERSONAL, 'blog', 4, 5)] });
    const groups = fx.groups.map((g) => (g.key === WORK ? { ...g, sessions: [...g.sessions, crossing] } : g));
    const result = groupSessions(groups, 'main-repo');
    const api = result.groups.find((g) => g.key === at(WORK, 'api'));
    expect(api?.sessions).toContain(crossing);
    expect(result.home.get(crossing.sessionId)).toBe(api);
    expect(result.groups.filter((g) => g.root === PERSONAL).flatMap((g) => g.sessions)).not.toContain(crossing);
  });

  it("keeps a root-started session that worked only in another root's repos in the root's own group (W149)", () => {
    const fx = fixture();
    const skills = session({ name: 'skills', cwd: WORK, workedIn: [repo(PERSONAL, 'skills', 6, 30)] });
    const groups = fx.groups.map((g) => (g.key === WORK ? { ...g, sessions: [...g.sessions, skills] } : g));
    const result = groupSessions(groups, 'main-repo');
    expect(result.groups.find((g) => g.key === WORK)?.sessions.map((s) => s.name).sort()).toEqual(['alone', 'skills']);
    expect(result.home.get(skills.sessionId)?.key).toBe(WORK);
    expect(result.groups.some((g) => g.key === at(PERSONAL, 'skills'))).toBe(false);
    // Every repo it worked in still lists it under that repo too, and keeps it in the root's own group.
    const every = groupSessions(groups, 'every-repo');
    expect(every.groups.find((g) => g.key === WORK)?.sessions).toContain(skills);
    expect(every.groups.find((g) => g.key === at(PERSONAL, 'skills'))?.sessions).toEqual([skills]);
    expect(every.home.get(skills.sessionId)?.key).toBe(WORK);
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
    expect(groups.map((g) => g.label)).toEqual(['work', 'api', 'blog', 'evals']);
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
      'in-notes': 'evals (work)',
      'in-blog': 'blog (personal)',
    });
  });

  it("keeps a root that is itself a repo a repo like any other: its sessions stay", () => {
    const inRepoRoot = session({ name: 'in-repo-root', cwd: WORK, workedIn: [repo(PERSONAL, 'blog', 9, 9)] });
    const groups = [group({ key: WORK, label: 'work', kind: 'git', root: WORK, sessions: [inRepoRoot] })];
    expect(placement(groupSessions(groups, 'main-repo').groups)).toEqual({ 'work (work)': ['in-repo-root'] });
  });
});

describe('groupSessions: a session started in a directory in no repo (W145)', () => {
  const NOTES = at(WORK, 'notes');
  const inNotes = (name: string, workedIn?: WorkedIn[]) => session({ name, cwd: NOTES, ...(workedIn ? { workedIn } : {}) });
  const notesGroup = (...sessions: ReturnType<typeof session>[]) => [group({ key: NOTES, label: 'notes', kind: 'directory', root: WORK, sessions })];

  it('moves to the one repo it worked in under its root, though it only read it; one under another root counts for nothing (W149)', () => {
    const cloned = inNotes('cloned', [repo(WORK, 'some-repo', 0, 40)]);
    const crossing = inNotes('crossing', [repo(PERSONAL, 'blog', 3, 9)]);
    const both = inNotes('both', [repo(PERSONAL, 'blog', 9, 90), repo(WORK, 'api', 1, 2)]);
    const result = groupSessions(notesGroup(cloned, crossing, both), 'main-repo');
    expect(placement(result.groups)).toEqual({ 'notes (work)': ['crossing'], 'some-repo (work)': ['cloned'], 'api (work)': ['both'] });
    expect(result.home.get(cloned.sessionId)?.key).toBe(at(WORK, 'some-repo'));
    expect(result.home.get(crossing.sessionId)?.key).toBe(NOTES);
  });

  it('stays in its directory with two or more repos, with none, and before its scan has landed', () => {
    const two = inNotes('two', [repo(WORK, 'api', 9, 90), repo(WORK, 'evals', 1, 10)]);
    const none = inNotes('none', []);
    const unscanned = inNotes('unscanned');
    for (const mode of ['main-repo', 'every-repo'] as const) {
      const result = groupSessions(notesGroup(two, none, unscanned), mode);
      expect(result.groups.find((g) => g.key === NOTES)?.sessions.map((s) => s.name).sort(), mode).toEqual(['none', 'two', 'unscanned']);
      for (const s of [two, none, unscanned]) expect(result.home.get(s.sessionId)?.key, mode).toBe(NOTES);
    }
  });

  it('counts only a placeable repo: one without a root leaves it where it started', () => {
    const old = { key: at(WORK, 'evals'), label: 'evals', calls: 9, changes: 9, lastAt: minutesAgo(1) } as unknown as WorkedIn;
    const mixed = inNotes('mixed', [old, repo(WORK, 'api', 1, 5)]);
    const onlyOld = inNotes('only-old', [old]);
    expect(placement(groupSessions(notesGroup(mixed, onlyOld), 'main-repo').groups)).toEqual({ 'notes (work)': ['only-old'], 'api (work)': ['mixed'] });
  });

  it('moves once its scan lands, and an open session view in the repo group stays open', () => {
    const before = inNotes('cloned');
    const after = { ...before, workedIn: [repo(WORK, 'some-repo', 2, 30)] };
    expect(groupSessions(notesGroup(before), 'main-repo').home.get(before.sessionId)?.key).toBe(NOTES);
    const moved = groupSessions(notesGroup(after), 'main-repo');
    expect(moved.home.get(after.sessionId)?.key).toBe(at(WORK, 'some-repo'));
    // Choosing the repo keeps it open; its directory no longer lists it, so choosing that would close it (W139).
    expect(keepsOpenSession(moved.groups, { repo: at(WORK, 'some-repo'), root: WORK }, after.sessionId)).toBe(true);
    expect(keepsOpenSession(moved.groups, { repo: NOTES, root: WORK }, after.sessionId)).toBe(false);
    // Opened from outside the list, it selects the repo, its home (W144).
    expect(selectionShowing({ roots: [WORK], groups: moved.groups }, { view: 'all' }, undefined, after.sessionId, moved.home)).toBeUndefined();
    expect(selectionShowing({ roots: [WORK], groups: moved.groups }, { repo: NOTES }, undefined, after.sessionId, moved.home)).toEqual({ repo: at(WORK, 'some-repo') });
  });

  it('is in Every repo it worked in under both its directory and the repo, its home the repo', () => {
    const cloned = inNotes('cloned', [repo(WORK, 'some-repo', 2, 30)]);
    const result = groupSessions(notesGroup(cloned), 'every-repo');
    expect(placement(result.groups)).toEqual({ 'notes (work)': ['cloned'], 'some-repo (work)': ['cloned'] });
    expect(result.home.get(cloned.sessionId)?.key).toBe(at(WORK, 'some-repo'));
  });

  it('stays where it started in Where it started', () => {
    const cloned = inNotes('cloned', [repo(WORK, 'some-repo', 2, 30)]);
    const groups = notesGroup(cloned);
    expect(groupSessions(groups, 'where-started').home.get(cloned.sessionId)).toBe(groups[0]);
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
      // in-notes started in notes, so it's there as well as under evals.
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

  it('gives each session a home: where it started, or the repo Main repo moves it to', () => {
    const fx = fixture();
    expect(homes(fx, 'every-repo')).toEqual({
      big: 'evals (work)',
      small: 'api (work)',
      alone: 'work (work)',
      'in-api': 'api (work)',
      'in-notes': 'evals (work)',
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
      ['in-notes', 'evals'],
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
