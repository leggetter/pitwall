import { describe, expect, it } from 'vitest';
import type { IndexSnapshot, SessionSummary } from '../shared/protocol.js';
import { findSession, resolveSession } from './sessions.js';

function summary(sessionId: string): SessionSummary {
  return {
    sessionId,
    name: `pitwall-test-${sessionId.slice(-2)}`,
    kind: 'background',
    shortId: 'bg0001',
    cwd: '/tmp/pitwall-test-root/repo',
    alive: true,
    startedAt: '2026-10-16T00:00:00.000Z',
    stale: false,
    finished: false,
    transcript: 'ok',
  };
}

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const snapshot: IndexSnapshot = {
  generatedAt: '2026-10-16T00:00:00.000Z',
  roots: ['/tmp/pitwall-test-root'],
  groups: [
    { key: '/tmp/pitwall-test-root/repo', label: 'repo', kind: 'git', root: '/tmp/pitwall-test-root', sessions: [summary(A)] },
    { key: '/tmp/pitwall-test-root/other', label: 'other', kind: 'directory', root: '/tmp/pitwall-test-root', sessions: [summary(B)] },
  ],
  source: { ok: true },
};

const indexer = (latest: IndexSnapshot | undefined) => ({ latest: () => latest });

describe('resolveSession', () => {
  it('returns the summary of a session in the current snapshot, from any group', () => {
    expect(resolveSession(indexer(snapshot), A)).toEqual({ ok: true, session: summary(A) });
    expect(resolveSession(indexer(snapshot), B)).toEqual({ ok: true, session: summary(B) });
  });

  it('answers 404 for a safe id that is not in the snapshot', () => {
    expect(resolveSession(indexer(snapshot), '33333333-3333-4333-8333-333333333333')).toEqual({ ok: false, status: 404 });
    // Matches the full session id only, never the short id.
    expect(resolveSession(indexer(snapshot), 'bg0001')).toEqual({ ok: false, status: 404 });
  });

  it('answers 503 before the first snapshot', () => {
    expect(resolveSession(indexer(undefined), A)).toEqual({ ok: false, status: 503 });
  });

  it.each([undefined, '', '..', '.hidden', '-rf', 'a/b', 'a\\b', 'a\0b', ' a', `${A}\n`, '../../etc/passwd'])(
    'answers 400 for the unsafe id %j, before looking at the snapshot',
    (id) => {
      let asked = false;
      const watching = { latest: () => ((asked = true), snapshot) };
      expect(resolveSession(watching, id)).toEqual({ ok: false, status: 400 });
      expect(asked).toBe(false);
    },
  );
});

describe('findSession', () => {
  it('finds by exact session id', () => {
    expect(findSession(snapshot, B)?.sessionId).toBe(B);
    expect(findSession(snapshot, `${B}0`)).toBeUndefined();
    expect(findSession(snapshot, B.slice(1))).toBeUndefined();
  });
});
