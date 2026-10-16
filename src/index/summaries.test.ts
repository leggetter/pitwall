import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../shared/protocol.js';
import type { AgentRow } from './agents.js';
import { buildGroups, compareSessions, isStale, toSessionSummary, type PlacedSession } from './summaries.js';

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
    transcript: 'ok',
    ...overrides,
  };
}

describe('isStale', () => {
  const oldBlocked = row({ kind: 'background', state: 'blocked', pid: undefined, status: undefined, startedAt: iso(NOW - 8 * DAY) });

  it('flags a blocked background session with no process that started over 7 days ago', () => {
    expect(isStale(oldBlocked, NOW)).toBe(true);
  });

  it('does not flag it when any one condition is missing', () => {
    expect(isStale({ ...oldBlocked, kind: 'interactive' }, NOW)).toBe(false);
    expect(isStale({ ...oldBlocked, state: 'working' }, NOW)).toBe(false);
    expect(isStale({ ...oldBlocked, state: 'done' }, NOW)).toBe(false);
    expect(isStale({ ...oldBlocked, pid: 123 }, NOW)).toBe(false);
    expect(isStale({ ...oldBlocked, startedAt: iso(NOW - 6 * DAY) }, NOW)).toBe(false);
    expect(isStale({ ...oldBlocked, startedAt: iso(NOW - 7 * DAY) }, NOW)).toBe(false);
  });
});

describe('toSessionSummary', () => {
  it('maps an interactive row with a readable transcript', () => {
    const summary = toSessionSummary(
      row({ status: 'busy' }),
      { transcript: 'ok', lastActivityAt: iso(NOW - 1000), lastAssistantText: 'working on it', lastUserPrompt: 'go' },
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
      lastActivityAt: iso(NOW - 1000),
      lastAssistantText: 'working on it',
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
      transcript: 'missing',
    });
  });
});

describe('compareSessions', () => {
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

  it('keeps one repo under two roots as two groups', () => {
    const groups = buildGroups([placed('x', '/repo', {}, '/repo/a'), placed('y', '/repo', {}, '/repo/b')], home);
    expect(groups.map((g) => g.root).sort()).toEqual(['/repo/a', '/repo/b']);
  });

  it('is empty without sessions', () => {
    expect(buildGroups([], home)).toEqual([]);
  });
});
