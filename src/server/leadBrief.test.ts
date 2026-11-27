// The paragraph a worker is given about its lead (W218 piece 2): the lead by name, only a lead the server
// trusts, and never a name that can't be an address or that another running session shares.
import { describe, expect, it } from 'vitest';
import type { IndexSnapshot, SessionSummary } from '../shared/protocol.js';
import { LEAD_NAME_MAX, leadBrief, leadNameProblem, workerBrief, workerBriefText } from './leadBrief.js';

const uuid = (d: string) => `${d.repeat(8)}-${d.repeat(4)}-4${d.repeat(3)}-8${d.repeat(3)}-${d.repeat(12)}`;
const A = uuid('a');
const B = uuid('b');
const C = uuid('c');

function session(sessionId: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId,
    name: `pitwall-test-${sessionId.slice(0, 4)}`,
    kind: 'background',
    cwd: '/tmp/pitwall-test-root/repo',
    alive: true,
    pid: 4242,
    startedAt: '2026-11-27T09:00:00.000Z',
    stale: false,
    finished: false,
    transcript: 'ok',
    ...overrides,
  };
}

function snapshotOf(...sessions: SessionSummary[]): IndexSnapshot {
  return {
    generatedAt: '2026-11-27T10:00:00.000Z',
    roots: ['/tmp/pitwall-test-root'],
    groups: [{ key: '/tmp/pitwall-test-root/repo', label: 'repo', kind: 'git', root: '/tmp/pitwall-test-root', sessions }],
    source: { ok: true },
  };
}

describe('workerBriefText()', () => {
  it('names the lead as the SendMessage address, says “your user”, and has no session id', () => {
    const text = workerBriefText('pitwall-test-lead');
    expect(text).toContain('"pitwall-test-lead"');
    expect(text).toContain('SendMessage');
    expect(text).toContain('your user');
    expect(text).not.toMatch(/Phil/);
    expect(text).not.toContain('\n');
  });
});

describe('leadNameProblem()', () => {
  const ok = (name: string) => leadNameProblem(snapshotOf(session(A, { name })), session(A, { name }));
  it('takes a plain name', () => {
    expect(ok('pitwall-test-lead')).toBeUndefined();
    expect(ok('x'.repeat(LEAD_NAME_MAX))).toBeUndefined();
  });

  it('refuses a name a SendMessage address can’t carry', () => {
    for (const name of ['', ' padded', 'padded ', 'x'.repeat(LEAD_NAME_MAX + 1), 'say "hi"', 'two\nlines', 'tab\there', 'ends [ab12]', 'hidden​space']) {
      expect(ok(name), name).toMatch(/Rename it with \/rename/);
    }
  });

  it('refuses a name another running session has, ignoring case, but not one an ended or stopped session has', () => {
    const lead = session(A, { name: 'pitwall-test-lead' });
    expect(leadNameProblem(snapshotOf(lead, session(B, { name: 'PITWALL-TEST-LEAD' })), lead)).toMatch(/Another running session/);
    expect(leadNameProblem(snapshotOf(lead, session(B, { name: 'pitwall-test-lead', alive: false })), lead)).toBeUndefined();
    expect(leadNameProblem(snapshotOf(lead, session(B, { name: 'pitwall-test-lead', ended: true })), lead)).toBeUndefined();
  });
});

describe('leadBrief() and workerBrief()', () => {
  const snapshot = snapshotOf(session(A, { name: 'pitwall-test-lead' }), session(B));
  const store = (trusted: Record<string, string>, targets: Record<string, string>) => ({
    trustedLead: (id: string) => trusted[id],
    reportTarget: (id: string) => targets[id],
  });

  it('answers the paragraph for a trusted, listed lead, by the id the store reads', () => {
    expect(leadBrief(store({ [C]: A }, {}), snapshot, C)).toEqual({ ok: true, leadId: A, leadName: 'pitwall-test-lead', text: workerBriefText('pitwall-test-lead') });
    expect(workerBrief(store({}, { [B]: A }), snapshot, B)).toMatchObject({ ok: true, leadId: A, leadName: 'pitwall-test-lead' });
  });

  it('refuses a lead the store doesn’t trust, one not listed, before the listing, or a name that can’t be the address', () => {
    expect(leadBrief(store({}, {}), snapshot, A)).toMatchObject({ ok: false, error: expect.stringMatching(/Make lead/) });
    expect(workerBrief(store({}, {}), snapshot, B)).toMatchObject({ ok: false });
    expect(leadBrief(store({ [A]: C }, {}), snapshot, A)).toMatchObject({ ok: false, error: expect.stringMatching(/isn't in pitwall's list/) });
    expect(leadBrief(store({ [A]: A }, {}), undefined, A)).toMatchObject({ ok: false, error: expect.stringMatching(/hasn't listed/) });
    const shared = snapshotOf(session(A, { name: 'pitwall-test-lead' }), session(B, { name: 'pitwall-test-lead' }));
    expect(leadBrief(store({ [A]: A }, {}), shared, A)).toMatchObject({ ok: false, error: expect.stringMatching(/Another running session/) });
  });
});
