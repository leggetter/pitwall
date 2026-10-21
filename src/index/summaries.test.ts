import { describe, expect, it } from 'vitest';
import type { AskedYou, SessionSummary } from '../shared/protocol.js';
import type { AgentRow } from './agents.js';
import { buildGroups, compareGroups, compareSessions, isFinished, isStale, toSessionSummary, type PlacedSession } from './summaries.js';
import { titleText, type TranscriptInfo } from './transcripts.js';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

function row(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    sessionId: '55555555-5555-4555-8555-555555555555',
    name: 'pitwall-test-row',
    kind: 'interactive',
    cwd: '/work/repo',
    pid: 100,
    status: 'idle',
    startedAt: iso(NOW - DAY),
    ...overrides,
  };
}

function session(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: id,
    name: id,
    kind: 'interactive',
    cwd: '/work/repo',
    alive: true,
    startedAt: iso(NOW - DAY),
    stale: false,
    finished: false,
    transcript: 'ok',
    ...overrides,
  };
}

describe('isStale', () => {
  const oldBlocked = row({ kind: 'background', state: 'blocked', pid: undefined, status: undefined, startedAt: iso(NOW - 30 * DAY) });

  it('flags a blocked background session with no activity for more than 7 days, with or without a process', () => {
    expect(isStale(oldBlocked, iso(NOW - 8 * DAY), NOW)).toBe(true);
    expect(isStale({ ...oldBlocked, pid: 123, status: 'idle' }, iso(NOW - 8 * DAY), NOW)).toBe(true);
  });

  it('uses startedAt when there is no activity from the transcript', () => {
    expect(isStale(oldBlocked, undefined, NOW)).toBe(true);
    expect(isStale({ ...oldBlocked, startedAt: iso(NOW - 6 * DAY) }, undefined, NOW)).toBe(false);
  });

  it('goes by the latest activity, not by when the session started', () => {
    expect(isStale(oldBlocked, iso(NOW - 6 * DAY), NOW)).toBe(false);
    expect(isStale(oldBlocked, iso(NOW - 7 * DAY), NOW)).toBe(false);
    expect(isStale(oldBlocked, iso(NOW - 7 * DAY - 1), NOW)).toBe(true);
  });

  it('flags only blocked background sessions', () => {
    const old = iso(NOW - 30 * DAY);
    expect(isStale({ ...oldBlocked, kind: 'interactive' }, old, NOW)).toBe(false);
    expect(isStale({ ...oldBlocked, state: 'working' }, old, NOW)).toBe(false);
    expect(isStale({ ...oldBlocked, state: 'done' }, old, NOW)).toBe(false);
    expect(isStale({ ...oldBlocked, state: undefined }, old, NOW)).toBe(false);
  });
});

describe('isFinished', () => {
  const finished = (overrides: Partial<SessionSummary> = {}) =>
    session('f', { kind: 'background', shortId: 'bg1', alive: false, pid: undefined, status: undefined, state: 'done', ...overrides });

  it('is true for a background session with no process that is done, stopped or failed', () => {
    for (const state of ['done', 'stopped', 'failed'] as const) {
      expect(isFinished(finished({ state })), state).toBe(true);
    }
  });

  it('is false for a done session whose process is still alive: that one is idle', () => {
    expect(isFinished(finished({ alive: true, pid: 4242, status: 'idle' }))).toBe(false);
  });

  it('treats a missing pid as no live process', () => {
    expect(isFinished(finished({ alive: true, pid: undefined }))).toBe(true);
  });

  it('is false for working and blocked sessions, and for one with no state', () => {
    expect(isFinished(finished({ state: 'working' }))).toBe(false);
    expect(isFinished(finished({ state: 'blocked' }))).toBe(false);
    expect(isFinished(finished({ state: undefined }))).toBe(false);
  });

  it('is false for interactive sessions', () => {
    expect(isFinished(finished({ kind: 'interactive', shortId: undefined }))).toBe(false);
  });

  it('is what toSessionSummary sets as finished', () => {
    const fromAll = toSessionSummary(row({ kind: 'background', shortId: 'bg2', pid: undefined, status: undefined, state: 'stopped' }), { transcript: 'ok' }, NOW);
    expect(fromAll.finished).toBe(true);
    expect(fromAll.alive).toBe(false);
    const idleDone = toSessionSummary(row({ kind: 'background', shortId: 'bg3', pid: 77, status: 'idle', state: 'done' }), { transcript: 'ok' }, NOW);
    expect(idleDone.finished).toBe(false);
    for (const state of ['done', 'failed'] as const) {
      expect(toSessionSummary(row({ kind: 'background', pid: undefined, status: undefined, state }), { transcript: 'missing' }, NOW).finished, state).toBe(true);
    }
    expect(toSessionSummary(row(), { transcript: 'ok' }, NOW).finished).toBe(false);
  });

  it('is never set together with stale', () => {
    const oldBlocked = row({ kind: 'background', pid: undefined, status: undefined, state: 'blocked', startedAt: iso(NOW - 30 * DAY) });
    const summary = toSessionSummary(oldBlocked, { transcript: 'missing' }, NOW);
    expect(summary.stale).toBe(true);
    expect(summary.finished).toBe(false);
  });
});

describe('toSessionSummary', () => {
  it('maps an interactive row with a readable transcript', () => {
    const summary = toSessionSummary(
      row({ status: 'busy' }),
      { transcript: 'ok', lastActivityAt: iso(NOW - 1000), lastUserPrompt: 'go' },
      NOW,
    );
    expect(summary).toEqual({
      sessionId: '55555555-5555-4555-8555-555555555555',
      name: 'pitwall-test-row',
      kind: 'interactive',
      cwd: '/work/repo',
      pid: 100,
      alive: true,
      status: 'busy',
      startedAt: iso(NOW - DAY),
      stale: false,
      finished: false,
      lastActivityAt: iso(NOW - 1000),
      lastUserPrompt: 'go',
      transcript: 'ok',
    });
  });

  it('maps a background row without a process or transcript', () => {
    const summary = toSessionSummary(
      row({ kind: 'background', shortId: 'ab12cd34', pid: undefined, status: undefined, state: 'blocked', waitingFor: 'input needed', startedAt: iso(NOW - 30 * DAY) }),
      { transcript: 'missing' },
      NOW,
    );
    expect(summary).toEqual({
      sessionId: '55555555-5555-4555-8555-555555555555',
      shortId: 'ab12cd34',
      name: 'pitwall-test-row',
      kind: 'background',
      cwd: '/work/repo',
      alive: false,
      state: 'blocked',
      waitingFor: 'input needed',
      startedAt: iso(NOW - 30 * DAY),
      stale: true,
      finished: false,
      transcript: 'missing',
    });
  });

  it('sets cwdMissing only when the directory has gone', () => {
    expect(toSessionSummary(row(), { transcript: 'ok' }, NOW, { cwdMissing: true }).cwdMissing).toBe(true);
    expect(toSessionSummary(row(), { transcript: 'ok' }, NOW, { cwdMissing: false })).not.toHaveProperty('cwdMissing');
    expect(toSessionSummary(row(), { transcript: 'ok' }, NOW)).not.toHaveProperty('cwdMissing');
  });

  describe('title', () => {
    const titled = (aiTitle: string, overrides: Partial<AgentRow> = {}) =>
      toSessionSummary(row(overrides), { transcript: 'ok', aiTitle }, NOW);

    it("is Claude Code's title, when there is one that differs from the name", () => {
      expect(titled('Review the auth flow', { name: 'git-a0' })).toMatchObject({
        name: 'git-a0',
        title: 'Review the auth flow',
        titleSource: 'claude-code',
      });
    });

    it('is left out when it says the same as the name, ignoring case and spacing', () => {
      for (const [name, aiTitle] of [
        ['Review the auth flow', 'Review the auth flow'],
        ['Review the auth flow', 'review THE auth flow'],
        ['  Review the auth flow ', 'Review  the auth flow'],
      ]) {
        const summary = titled(aiTitle as string, { kind: 'background', name: name as string });
        expect(summary, `${name} / ${aiTitle}`).not.toHaveProperty('title');
        expect(summary).not.toHaveProperty('titleSource');
      }
    });

    it('compares a long name as the title would show it, cut to 120 characters', () => {
      const name = `Background job ${'with a long name '.repeat(10)}`;
      const aiTitle = titleText(name);
      expect(aiTitle).toHaveLength(120);
      expect(titled(aiTitle, { name })).not.toHaveProperty('title');
    });

    it('is left out when there is no title', () => {
      const summary = toSessionSummary(row(), { transcript: 'ok' }, NOW);
      expect(summary).not.toHaveProperty('title');
      expect(summary).not.toHaveProperty('titleSource');
    });
  });

  describe('askedYou', () => {
    const asked: AskedYou = { reason: 'question', excerpt: 'Should I push it?' };
    const transcript: TranscriptInfo = { transcript: 'ok', lastActivityAt: iso(NOW - 1000), askedYou: asked };
    const background = (overrides: Partial<AgentRow>) =>
      row({ kind: 'background', shortId: 'ab12', status: undefined, pid: undefined, ...overrides });

    it('is kept for a session that has finished its turn', () => {
      expect(toSessionSummary(row({ status: 'idle' }), transcript, NOW).askedYou).toEqual(asked);
      expect(toSessionSummary(row({ status: undefined, pid: undefined }), transcript, NOW).askedYou).toEqual(asked);
      for (const state of ['done', 'failed', 'stopped'] as const) {
        expect(toSessionSummary(background({ state }), transcript, NOW).askedYou, state).toEqual(asked);
      }
    });

    it('is dropped while the session is busy, waiting, working or blocked', () => {
      expect(toSessionSummary(row({ status: 'busy' }), transcript, NOW)).not.toHaveProperty('askedYou');
      expect(toSessionSummary(row({ status: 'waiting' }), transcript, NOW)).not.toHaveProperty('askedYou');
      expect(toSessionSummary(background({ state: 'working' }), transcript, NOW)).not.toHaveProperty('askedYou');
      expect(toSessionSummary(background({ state: 'blocked' }), transcript, NOW)).not.toHaveProperty('askedYou');
      expect(toSessionSummary(background({ state: 'done', status: 'busy', pid: 9 }), transcript, NOW)).not.toHaveProperty(
        'askedYou',
      );
    });

    it('is dropped for a stale session', () => {
      const summary = toSessionSummary(background({ state: 'blocked' }), { ...transcript, lastActivityAt: iso(NOW - 9 * DAY) }, NOW);
      expect(summary.stale).toBe(true);
      expect(summary).not.toHaveProperty('askedYou');
    });

    it('is absent when the transcript did not ask', () => {
      expect(toSessionSummary(row(), { transcript: 'ok' }, NOW)).not.toHaveProperty('askedYou');
    });
  });
});

describe('compareSessions', () => {
  it('puts waiting first, then asked you, then busy, then the most recently active, with stale sessions last', () => {
    const asked: AskedYou = { reason: 'question', excerpt: 'Ship it?' };
    const sessions = [
      session('idle', { status: 'idle', lastActivityAt: iso(NOW - 1000) }),
      session('busy', { status: 'busy', lastActivityAt: iso(NOW - 500) }),
      session('asked-old', { status: 'idle', askedYou: asked, lastActivityAt: iso(NOW - 90_000) }),
      session('stale', { alive: false, stale: true, kind: 'background', state: 'blocked', lastActivityAt: iso(NOW) }),
      session('asked-new', { status: 'idle', askedYou: asked, lastActivityAt: iso(NOW - 10_000) }),
      session('waiting', { status: 'waiting', lastActivityAt: iso(NOW - 99_000) }),
    ];
    expect(sessions.sort(compareSessions).map((s) => s.sessionId)).toEqual([
      'waiting',
      'asked-new',
      'asked-old',
      'busy',
      'idle',
      'stale',
    ]);
  });

  it('puts waiting first, then busy, then the most recently active, with stale sessions last', () => {
    const sessions = [
      session('idle-old', { status: 'idle', lastActivityAt: iso(NOW - 5000) }),
      session('stale', { alive: false, stale: true, kind: 'background', lastActivityAt: iso(NOW) }),
      session('busy', { status: 'busy', lastActivityAt: iso(NOW - 9000) }),
      session('idle-new', { status: 'idle', lastActivityAt: iso(NOW - 1000) }),
      session('waiting', { status: 'waiting', lastActivityAt: iso(NOW - 99_000) }),
      session('no-status', { alive: false, lastActivityAt: iso(NOW - 3000) }),
    ];
    expect(sessions.sort(compareSessions).map((s) => s.sessionId)).toEqual([
      'waiting',
      'busy',
      'idle-new',
      'no-status',
      'idle-old',
      'stale',
    ]);
  });

  it('puts a blocked background job first, as Claude Code reports it: blocked and idle', () => {
    const sessions = [
      session('busy', { status: 'busy', lastActivityAt: iso(NOW - 5000) }),
      session('idle-newer', { status: 'idle', lastActivityAt: iso(NOW - 1000) }),
      session('blocked', { kind: 'background', shortId: 'bg1', status: 'idle', state: 'blocked', lastActivityAt: iso(NOW - 60_000) }),
    ];
    expect(sessions.sort(compareSessions).map((s) => s.sessionId)).toEqual(['blocked', 'busy', 'idle-newer']);
  });

  it('ranks a blocked job with waiting sessions, by activity, ahead of asked you', () => {
    const asked: AskedYou = { reason: 'question', excerpt: 'Ship it?' };
    const sessions = [
      session('asked', { status: 'idle', askedYou: asked, lastActivityAt: iso(NOW - 100) }),
      session('waiting-old', { status: 'waiting', lastActivityAt: iso(NOW - 50_000) }),
      session('blocked-no-process', { kind: 'background', alive: false, state: 'blocked', lastActivityAt: iso(NOW - 20_000) }),
      session('blocked-new', { kind: 'background', status: 'idle', state: 'blocked', lastActivityAt: iso(NOW - 1000) }),
    ];
    expect(sessions.sort(compareSessions).map((s) => s.sessionId)).toEqual([
      'blocked-new',
      'blocked-no-process',
      'waiting-old',
      'asked',
    ]);
  });

  it('keeps a stale blocked job last', () => {
    const sessions = [
      session('stale-blocked', { kind: 'background', status: 'idle', state: 'blocked', stale: true, lastActivityAt: iso(NOW) }),
      session('idle', { status: 'idle', lastActivityAt: iso(NOW - 9 * DAY) }),
    ];
    expect(sessions.sort(compareSessions).map((s) => s.sessionId)).toEqual(['idle', 'stale-blocked']);
  });

  it('puts finished sessions last, after stale ones, however recent or waiting-like they look', () => {
    const asked: AskedYou = { reason: 'question', excerpt: 'Open a PR?' };
    const done = { kind: 'background' as const, alive: false, state: 'done' as const, finished: true };
    const sessions = [
      session('finished-new', { ...done, lastActivityAt: iso(NOW) }),
      session('stale', { kind: 'background', alive: false, state: 'blocked', stale: true, lastActivityAt: iso(NOW - 30 * DAY) }),
      session('finished-asked', { ...done, askedYou: asked, lastActivityAt: iso(NOW - 5000) }),
      session('idle-old', { status: 'idle', lastActivityAt: iso(NOW - 9 * DAY) }),
      session('failed', { ...done, state: 'failed', lastActivityAt: iso(NOW - 1000) }),
      session('stopped-old', { ...done, state: 'stopped', lastActivityAt: iso(NOW - 2 * DAY) }),
    ];
    expect(sessions.sort(compareSessions).map((s) => s.sessionId)).toEqual([
      'idle-old',
      'stale',
      'finished-new',
      'failed',
      'finished-asked',
      'stopped-old',
    ]);
  });

  it('keeps a done session with a live process among the unfinished ones', () => {
    const sessions = [
      session('finished', { kind: 'background', alive: false, state: 'done', finished: true, lastActivityAt: iso(NOW) }),
      session('done-idle', { kind: 'background', pid: 55, status: 'idle', state: 'done', lastActivityAt: iso(NOW - 60_000) }),
    ];
    expect(sessions.sort(compareSessions).map((s) => s.sessionId)).toEqual(['done-idle', 'finished']);
  });

  it('falls back to startedAt when there is no lastActivityAt', () => {
    const sessions = [
      session('older-start', { startedAt: iso(NOW - 2 * DAY) }),
      session('newer-start', { startedAt: iso(NOW - 1000), transcript: 'missing' }),
    ];
    expect(sessions.sort(compareSessions).map((s) => s.sessionId)).toEqual(['newer-start', 'older-start']);
  });
});

describe('buildGroups', () => {
  const root = '/Users/someone/git';
  const home = '/Users/someone';

  function placed(id: string, key: string, overrides: Partial<SessionSummary> = {}, groupRoot = root, kind: 'git' | 'directory' = 'git'): PlacedSession {
    return { root: groupRoot, group: { key, kind }, summary: session(id, overrides) };
  }

  it('groups by root and key, labels the groups and sorts both levels', () => {
    const groups = buildGroups(
      [
        placed('a1', `${root}/alpha`, { lastActivityAt: iso(NOW - 50_000) }),
        placed('b1', `${root}/beta`, { lastActivityAt: iso(NOW - 1000) }),
        placed('a2', `${root}/alpha`, { status: 'waiting', lastActivityAt: iso(NOW - 90_000) }),
        placed('r1', root, { lastActivityAt: iso(NOW - 20_000) }, root, 'directory'),
        placed('w1', `${root}/main-repo`, { lastActivityAt: iso(NOW - 30_000) }, `${root}/worktrees`),
      ],
      home,
    );
    expect(groups.map((g) => ({ key: g.key, label: g.label, kind: g.kind, root: g.root, ids: g.sessions.map((s) => s.sessionId) }))).toEqual([
      { key: `${root}/beta`, label: 'beta', kind: 'git', root, ids: ['b1'] },
      { key: root, label: 'git', kind: 'directory', root, ids: ['r1'] },
      { key: `${root}/main-repo`, label: '~/git/main-repo', kind: 'git', root: `${root}/worktrees`, ids: ['w1'] },
      { key: `${root}/alpha`, label: 'alpha', kind: 'git', root, ids: ['a2', 'a1'] },
    ]);
  });

  it('orders groups by their unfinished sessions, so a recent finished session does not lift its group', () => {
    const finished = { kind: 'background' as const, alive: false, state: 'done' as const, finished: true };
    const groups = buildGroups(
      [
        placed('quiet-live', `${root}/quiet`, { lastActivityAt: iso(NOW - 60_000) }),
        placed('quiet-finished', `${root}/quiet`, { ...finished, lastActivityAt: iso(NOW) }),
        placed('busy-live', `${root}/busy`, { lastActivityAt: iso(NOW - 10_000) }),
      ],
      home,
    );
    expect(groups.map((g) => g.key)).toEqual([`${root}/busy`, `${root}/quiet`]);
    expect(groups[1]?.sessions.map((s) => s.sessionId)).toEqual(['quiet-live', 'quiet-finished']);
  });

  it('puts groups with only finished sessions after every other group, newest first', () => {
    const finished = { kind: 'background' as const, alive: false, state: 'stopped' as const, finished: true };
    const groups = buildGroups(
      [
        placed('done-new', `${root}/done-new`, { ...finished, lastActivityAt: iso(NOW) }),
        placed('live-old', `${root}/live-old`, { lastActivityAt: iso(NOW - 20 * DAY) }),
        placed('done-old', `${root}/done-old`, { ...finished, lastActivityAt: iso(NOW - 3 * DAY) }),
        placed('stale-only', `${root}/stale-only`, { kind: 'background', alive: false, state: 'blocked', stale: true, lastActivityAt: iso(NOW - 40 * DAY) }),
      ],
      home,
    );
    expect(groups.map((g) => g.key)).toEqual([`${root}/live-old`, `${root}/stale-only`, `${root}/done-new`, `${root}/done-old`]);
  });

  it('keeps compareGroups consistent with the order buildGroups returns', () => {
    const finished = { kind: 'background' as const, alive: false, state: 'failed' as const, finished: true };
    const groups = buildGroups(
      [
        placed('a', `${root}/a`, { ...finished, lastActivityAt: iso(NOW) }),
        placed('b', `${root}/b`, { lastActivityAt: iso(NOW - DAY) }),
        placed('c', `${root}/c`, { ...finished, lastActivityAt: iso(NOW - 1000) }),
        placed('c2', `${root}/c`, { lastActivityAt: iso(NOW - 2 * DAY) }),
      ],
      home,
    );
    for (let i = 0; i + 1 < groups.length; i++) {
      expect(compareGroups(groups[i]!, groups[i + 1]!)).toBeLessThan(0);
    }
    expect(groups.map((g) => g.key)).toEqual([`${root}/b`, `${root}/c`, `${root}/a`]);
  });

  it('keeps one repo under two roots as two groups', () => {
    const groups = buildGroups([placed('x', '/repo', {}, '/repo/a'), placed('y', '/repo', {}, '/repo/b')], home);
    expect(groups.map((g) => g.root).sort()).toEqual(['/repo/a', '/repo/b']);
  });

  it('is empty without sessions', () => {
    expect(buildGroups([], home)).toEqual([]);
  });

  describe('with the repos sessions worked in (W34)', () => {
    /** A session placed by where it started, with the repos it worked in under `root`. */
    function worked(id: string, key: string, kind: 'git' | 'directory', repos: string[], overrides: Partial<SessionSummary> = {}, sessionRoot = root): PlacedSession {
      return { ...placed(id, key, overrides, sessionRoot, kind), workedIn: repos.map((repo) => ({ key: repo, root })) };
    }
    const view = (groups: ReturnType<typeof buildGroups>) =>
      groups.map((g) => [g.label, g.kind, g.sessions.map((s) => s.sessionId)] as const).sort((a, b) => (a[0] < b[0] ? -1 : 1));

    it('lists a session under the repo it started in, and under every repo it worked in', () => {
      const groups = buildGroups(
        [
          worked('started-in-alpha', `${root}/alpha`, 'git', [`${root}/beta`, `${root}/gamma`]),
          worked('only-alpha', `${root}/alpha`, 'git', []),
          worked('started-in-beta', `${root}/beta`, 'git', []),
        ],
        home,
      );
      expect(view(groups)).toEqual([
        ['alpha', 'git', ['only-alpha', 'started-in-alpha']],
        ['beta', 'git', ['started-in-alpha', 'started-in-beta']],
        ['gamma', 'git', ['started-in-alpha']],
      ]);
      // One session in three groups, each listing it once.
      for (const group of groups) expect(new Set(group.sessions.map((s) => s.sessionId)).size).toBe(group.sessions.length);
      expect(groups.filter((g) => g.sessions.some((s) => s.sessionId === 'started-in-alpha')).map((g) => g.label).sort()).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('gives a repo reached only through workedIn a group of its own, labelled as any other', () => {
      const groups = buildGroups([worked('s', `${root}/alpha`, 'git', [`${root}/projects/delta`])], home);
      expect(groups.find((g) => g.key === `${root}/projects/delta`)).toMatchObject({ label: 'projects/delta', kind: 'git', root, sessions: [{ sessionId: 's' }] });
    });

    it("keeps a session started in the root with no workedIn in the root's group", () => {
      const groups = buildGroups([worked('in-root', root, 'directory', [])], home);
      expect(view(groups)).toEqual([['git', 'directory', ['in-root']]]);
    });

    it("takes a session started in the root that worked in repos out of the root's group, which is left out once empty", () => {
      const groups = buildGroups([worked('in-root', root, 'directory', [`${root}/alpha`, `${root}/beta`])], home);
      expect(view(groups)).toEqual([
        ['alpha', 'git', ['in-root']],
        ['beta', 'git', ['in-root']],
      ]);
      expect(groups.some((g) => g.key === root)).toBe(false);
    });

    it("keeps the root's group for the root-started sessions that worked in no repo", () => {
      const groups = buildGroups([worked('moved', root, 'directory', [`${root}/alpha`]), worked('stays', root, 'directory', [])], home);
      expect(view(groups)).toEqual([
        ['alpha', 'git', ['moved']],
        ['git', 'directory', ['stays']],
      ]);
    });

    it('keeps a directory below the root that is in no repo as a group of its own', () => {
      const groups = buildGroups([worked('in-notes', `${root}/notes`, 'directory', []), worked('in-root', root, 'directory', [])], home);
      expect(view(groups)).toEqual([
        ['git', 'directory', ['in-root']],
        ['notes', 'directory', ['in-notes']],
      ]);
    });

    it('lists a session started in such a directory there and under the repos it worked in', () => {
      const groups = buildGroups([worked('in-notes', `${root}/notes`, 'directory', [`${root}/alpha`])], home);
      expect(view(groups)).toEqual([
        ['alpha', 'git', ['in-notes']],
        ['notes', 'directory', ['in-notes']],
      ]);
    });

    it("puts a repo's group under the root the repo is in, whichever root the session is under", () => {
      const other = '/Users/someone/work';
      const groups = buildGroups(
        [{ ...placed('s', `${root}/alpha`), workedIn: [{ key: `${other}/service`, root: other }] }],
        home,
      );
      expect(groups.find((g) => g.key === `${other}/service`)).toMatchObject({ root: other, label: 'service', sessions: [{ sessionId: 's' }] });
    });

    it('sorts the sessions in a repo reached through workedIn as any group, and the groups as before', () => {
      const groups = buildGroups(
        [
          worked('quiet', `${root}/alpha`, 'git', [`${root}/shared`], { lastActivityAt: iso(NOW - 90_000) }),
          worked('waiting', `${root}/beta`, 'git', [`${root}/shared`], { status: 'waiting', lastActivityAt: iso(NOW - 99_000) }),
          worked('recent', `${root}/shared`, 'git', [], { lastActivityAt: iso(NOW - 1000) }),
        ],
        home,
      );
      expect(groups.find((g) => g.key === `${root}/shared`)?.sessions.map((s) => s.sessionId)).toEqual(['waiting', 'recent', 'quiet']);
      expect(groups.map((g) => g.label)).toEqual(['shared', 'alpha', 'beta']);
    });
  });
});
