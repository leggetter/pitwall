import { describe, expect, it } from 'vitest';
import type { AskedYou, SessionSummary } from '../shared/protocol.js';
import type { AgentRow } from './agents.js';
import { buildGroups, compareGroups, compareSessions, isFinished, isStale, restartHolds, toSessionSummary, type PlacedSession } from './summaries.js';
import { titleText, type TranscriptInfo } from './transcripts.js';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const asked: AskedYou = { reason: 'question', excerpt: 'Ship it?' };
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

  it('maps an ended interactive session (W66): finished and ended, with no process, keeping its question', () => {
    const asked: AskedYou = { reason: 'question', excerpt: 'Shall I push it?' };
    const ended = row({ name: 'repo-55555555', pid: undefined, status: undefined });
    const summary = toSessionSummary(ended, { transcript: 'ok', lastActivityAt: iso(NOW - DAY), askedYou: asked, aiTitle: 'Push the fix' }, NOW, { ended: true });
    expect(summary).toEqual({
      sessionId: '55555555-5555-4555-8555-555555555555',
      name: 'repo-55555555',
      title: 'Push the fix',
      titleSource: 'claude-code',
      kind: 'interactive',
      cwd: '/work/repo',
      alive: false,
      startedAt: iso(NOW - DAY),
      stale: false,
      finished: true,
      ended: true,
      askedYou: asked,
      lastActivityAt: iso(NOW - DAY),
      transcript: 'ok',
    });
    expect(toSessionSummary(row(), { transcript: 'ok' }, NOW)).not.toHaveProperty('ended');
    // Sorted with the finished sessions, last, its question lifting it over none of them.
    const live = session('live', { lastActivityAt: iso(NOW - 3 * DAY) });
    const done = session('done', { kind: 'background', alive: false, state: 'done', finished: true, lastActivityAt: iso(NOW - 2 * DAY) });
    expect([summary, done, live].sort(compareSessions).map((s) => s.sessionId)).toEqual(['live', summary.sessionId, 'done']);
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

    describe("with the turn's end read from the transcript (spike 007, findings 4 and 6)", () => {
      const ended: TranscriptInfo = { ...transcript, turnEnded: true };
      const running: TranscriptInfo = { ...transcript, turnEnded: false };

      it("is kept once the turn has ended, though a plugin's monitor keeps Claude Code's status at busy or working", () => {
        expect(toSessionSummary(row({ status: 'busy' }), ended, NOW).askedYou).toEqual(asked);
        expect(toSessionSummary(background({ state: 'working', status: 'busy', pid: 9 }), ended, NOW).askedYou).toEqual(asked);
        expect(toSessionSummary(background({ state: 'blocked' }), ended, NOW).askedYou).toEqual(asked);
      });

      it('is dropped while the turn runs, whatever the status says', () => {
        expect(toSessionSummary(row({ status: 'idle' }), running, NOW)).not.toHaveProperty('askedYou');
        expect(toSessionSummary(background({ state: 'done', pid: 9, status: 'idle' }), running, NOW)).not.toHaveProperty('askedYou');
      });

      it('is still dropped while a prompt is on screen, and on a stale session', () => {
        expect(toSessionSummary(row({ status: 'waiting' }), ended, NOW)).not.toHaveProperty('askedYou');
        const stale = toSessionSummary(background({ state: 'blocked' }), { ...ended, lastActivityAt: iso(NOW - 9 * DAY) }, NOW);
        expect(stale.stale).toBe(true);
        expect(stale).not.toHaveProperty('askedYou');
      });

      it("goes by Claude Code's status for a transcript with no turn_duration entries, as from an older Claude Code", () => {
        expect(transcript).not.toHaveProperty('turnEnded');
        expect(toSessionSummary(row({ status: 'busy' }), transcript, NOW)).not.toHaveProperty('askedYou');
        expect(toSessionSummary(row({ status: 'idle' }), transcript, NOW).askedYou).toEqual(asked);
      });
    });
  });

  describe('needsYou (W69)', () => {
    const background = (overrides: Partial<AgentRow> = {}) =>
      row({ kind: 'background', shortId: 'ab12', pid: 77, status: 'idle', state: 'blocked', ...overrides });
    const quiet: TranscriptInfo = { transcript: 'ok', lastActivityAt: iso(NOW - 60_000) };
    const askedTurn: TranscriptInfo = { ...quiet, askedYou: asked, turnEnded: true };
    const needs = (text: string) => ({ kind: 'needs' as const, text });

    it("is 'prompt' while Claude Code shows a prompt, before any other reason", () => {
      const summary = toSessionSummary(background({ status: 'waiting', waitingFor: 'permission prompt' }), askedTurn, NOW, {
        job: needs('Tea or coffee?'),
        restartedAtMs: NOW - 1000,
      });
      expect(summary.needsYou).toEqual({ reason: 'prompt' });
      expect(toSessionSummary(row({ status: 'waiting' }), quiet, NOW).needsYou).toEqual({ reason: 'prompt' });
    });

    it("is 'claude-code' with the job's own line, ahead of asked you", () => {
      const summary = toSessionSummary(background(), askedTurn, NOW, { job: needs('Do you prefer tea or coffee?') });
      expect(summary.needsYou).toEqual({ reason: 'claude-code', text: 'Do you prefer tea or coffee?' });
    });

    it("is 'asked' when the last turn asked you, ahead of a restart", () => {
      expect(toSessionSummary(row(), askedTurn, NOW, { restartedAtMs: NOW - 1000 }).needsYou).toEqual({ reason: 'asked' });
      expect(toSessionSummary(background(), askedTurn, NOW, { job: { kind: 'none' } }).needsYou).toEqual({ reason: 'asked' });
    });

    it("is 'restarted' after a restart, until a prompt newer than it", () => {
      const restartedAtMs = NOW - 30_000;
      const working = background({ state: 'working', status: 'busy' });
      expect(toSessionSummary(working, { ...quiet, lastPromptMs: restartedAtMs - 5000 }, NOW, { job: { kind: 'none' }, restartedAtMs }).needsYou).toEqual({
        reason: 'restarted',
      });
      expect(toSessionSummary(working, quiet, NOW, { restartedAtMs }).needsYou).toEqual({ reason: 'restarted' });
      expect(toSessionSummary(working, { ...quiet, lastPromptMs: restartedAtMs + 1 }, NOW, { restartedAtMs })).not.toHaveProperty('needsYou');
    });

    it("is 'blocked' for a blocked job whose file couldn't be used, or wasn't read", () => {
      expect(toSessionSummary(background(), quiet, NOW, { job: { kind: 'unknown' } }).needsYou).toEqual({ reason: 'blocked' });
      expect(toSessionSummary(background(), quiet, NOW).needsYou).toEqual({ reason: 'blocked' });
      expect(toSessionSummary(background({ shortId: undefined }), quiet, NOW).needsYou).toEqual({ reason: 'blocked' });
    });

    it("is absent for a blocked job whose file was read and asks nothing, as a resumed session's placeholder", () => {
      expect(toSessionSummary(background(), quiet, NOW, { job: { kind: 'none' } })).not.toHaveProperty('needsYou');
    });

    it('is absent for a session with no reason', () => {
      expect(toSessionSummary(row({ status: 'idle' }), quiet, NOW)).not.toHaveProperty('needsYou');
      expect(toSessionSummary(row({ status: 'busy' }), quiet, NOW)).not.toHaveProperty('needsYou');
      expect(toSessionSummary(background({ state: 'working', status: 'busy' }), quiet, NOW, { job: { kind: 'unknown' } })).not.toHaveProperty('needsYou');
    });

    it('is never set on a stale or a finished session, whatever its reasons', () => {
      const old: TranscriptInfo = { ...askedTurn, lastActivityAt: iso(NOW - 9 * DAY) };
      const stale = toSessionSummary(background({ status: 'waiting' }), old, NOW, { job: needs('Still there?'), restartedAtMs: NOW - 1000 });
      expect(stale.stale).toBe(true);
      expect(stale).not.toHaveProperty('needsYou');
      const done = toSessionSummary(background({ state: 'done', pid: undefined, status: undefined }), askedTurn, NOW, { job: needs('?'), restartedAtMs: NOW - 1000 });
      expect(done.finished).toBe(true);
      expect(done).not.toHaveProperty('needsYou');
      const endedSession = toSessionSummary(row({ pid: undefined, status: undefined }), askedTurn, NOW, { ended: true, restartedAtMs: NOW - 1000 });
      expect(endedSession.askedYou).toEqual(asked);
      expect(endedSession).not.toHaveProperty('needsYou');
    });
  });
});

describe('restartHolds', () => {
  it('holds until the transcript has a prompt newer than the restart', () => {
    expect(restartHolds(NOW, {})).toBe(true);
    expect(restartHolds(NOW, { lastPromptMs: NOW - 1 })).toBe(true);
    expect(restartHolds(NOW, { lastPromptMs: NOW })).toBe(true);
    expect(restartHolds(NOW, { lastPromptMs: NOW + 1 })).toBe(false);
  });
});

describe('compareSessions', () => {
  it('puts needs you first, whatever the reason, then busy, then the most recently active, with stale sessions last', () => {
    const sessions = [
      session('idle', { status: 'idle', lastActivityAt: iso(NOW - 1000) }),
      session('busy', { status: 'busy', lastActivityAt: iso(NOW - 500) }),
      session('asked-old', { status: 'idle', askedYou: asked, needsYou: { reason: 'asked' }, lastActivityAt: iso(NOW - 90_000) }),
      session('stale', { alive: false, stale: true, kind: 'background', state: 'blocked', lastActivityAt: iso(NOW) }),
      session('restarted', { status: 'busy', needsYou: { reason: 'restarted' }, lastActivityAt: iso(NOW - 5000) }),
      session('asked-new', { status: 'idle', askedYou: asked, needsYou: { reason: 'asked' }, lastActivityAt: iso(NOW - 10_000) }),
      session('waiting', { status: 'waiting', needsYou: { reason: 'prompt' }, lastActivityAt: iso(NOW - 99_000) }),
    ];
    expect(sessions.sort(compareSessions).map((s) => s.sessionId)).toEqual([
      'restarted',
      'asked-new',
      'asked-old',
      'waiting',
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
      session('waiting', { status: 'waiting', needsYou: { reason: 'prompt' }, lastActivityAt: iso(NOW - 99_000) }),
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

  it('puts a blocked job first when it needs you, and among the idle ones when it does not (W69)', () => {
    const blocked = { kind: 'background' as const, shortId: 'bg1', status: 'idle' as const, state: 'blocked' as const };
    const sessions = [
      session('busy', { status: 'busy', lastActivityAt: iso(NOW - 5000) }),
      session('idle-newer', { status: 'idle', lastActivityAt: iso(NOW - 1000) }),
      session('blocked-asks', { ...blocked, needsYou: { reason: 'claude-code', text: 'Tea or coffee?' }, lastActivityAt: iso(NOW - 60_000) }),
      session('blocked-placeholder', { ...blocked, lastActivityAt: iso(NOW - 2000) }),
    ];
    expect(sessions.sort(compareSessions).map((s) => s.sessionId)).toEqual(['blocked-asks', 'busy', 'idle-newer', 'blocked-placeholder']);
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
        placed('a2', `${root}/alpha`, { status: 'waiting', needsYou: { reason: 'prompt' }, lastActivityAt: iso(NOW - 90_000) }),
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

  describe('each session in one group, the one it started in (W39)', () => {
    /** A session placed by where it started, whose summary names the repos under `root` it worked in. */
    function worked(id: string, key: string, kind: 'git' | 'directory', repos: string[], overrides: Partial<SessionSummary> = {}): PlacedSession {
      const workedIn = repos.map((repo) => ({ key: repo, label: repo.slice(root.length + 1), root, calls: 10, changes: 1, lastAt: iso(NOW) }));
      return placed(id, key, { ...overrides, ...(workedIn.length > 0 ? { workedIn } : {}) }, root, kind);
    }
    const view = (groups: ReturnType<typeof buildGroups>) =>
      groups.map((g) => [g.label, g.kind, g.sessions.map((s) => s.sessionId)] as const).sort((a, b) => (a[0] < b[0] ? -1 : 1));

    it("lists a session started in the root only in the root's group, whatever repos it worked in", () => {
      const groups = buildGroups([worked('in-root', root, 'directory', [`${root}/alpha`, `${root}/beta`]), worked('in-root-alone', root, 'directory', [])], home);
      expect(view(groups)).toEqual([['git', 'directory', ['in-root', 'in-root-alone']]]);
      // Its summary still names both repos, for the session view and the filter.
      expect(groups[0]?.sessions.find((s) => s.sessionId === 'in-root')?.workedIn?.map((repo) => repo.label)).toEqual(['alpha', 'beta']);
    });

    it('lists a session started in a repo only there, not under a sibling it worked in', () => {
      const groups = buildGroups([worked('in-alpha', `${root}/alpha`, 'git', [`${root}/beta`]), worked('in-beta', `${root}/beta`, 'git', [])], home);
      expect(view(groups)).toEqual([
        ['alpha', 'git', ['in-alpha']],
        ['beta', 'git', ['in-beta']],
      ]);
    });

    it('leaves out a repo that sessions only worked in', () => {
      const groups = buildGroups([worked('in-alpha', `${root}/alpha`, 'git', [`${root}/projects/delta`]), worked('in-root', root, 'directory', [`${root}/projects/delta`])], home);
      expect(groups.some((g) => g.key === `${root}/projects/delta`)).toBe(false);
      expect(view(groups)).toEqual([
        ['alpha', 'git', ['in-alpha']],
        ['git', 'directory', ['in-root']],
      ]);
    });

    it('lists a session started in a directory below the root that is in no repo there alone', () => {
      const groups = buildGroups([worked('in-notes', `${root}/notes`, 'directory', [`${root}/alpha`]), worked('in-root', root, 'directory', [])], home);
      expect(view(groups)).toEqual([
        ['git', 'directory', ['in-root']],
        ['notes', 'directory', ['in-notes']],
      ]);
    });

    it("keeps a worktree's and a subdirectory's sessions under their repo, whatever else they worked in", () => {
      // The group resolver gives both the main repo's key: a subdirectory's top level, a worktree's common dir.
      const groups = buildGroups(
        [worked('in-src', `${root}/alpha`, 'git', [`${root}/beta`], { cwd: `${root}/alpha/src` }), worked('in-worktree', `${root}/alpha`, 'git', [`${root}/beta`], { cwd: `${root}/alpha-worktrees/feature` })],
        home,
      );
      expect(view(groups)).toEqual([['alpha', 'git', ['in-src', 'in-worktree']]]);
    });

    it('lists each session in exactly one group, and its group counts it once', () => {
      const sessions = [
        worked('a', `${root}/alpha`, 'git', [`${root}/beta`, `${root}/gamma`]),
        worked('b', `${root}/beta`, 'git', [`${root}/alpha`]),
        worked('r', root, 'directory', [`${root}/alpha`, `${root}/gamma`]),
        worked('n', `${root}/notes`, 'directory', [`${root}/beta`]),
      ];
      const groups = buildGroups(sessions, home);
      const listed = groups.flatMap((g) => g.sessions.map((s) => s.sessionId));
      expect(listed.sort()).toEqual(['a', 'b', 'n', 'r']);
      expect(groups.reduce((sum, g) => sum + g.sessions.length, 0)).toBe(sessions.length);
    });
  });
});
