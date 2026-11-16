// The Needs you rules the page and the server share (W165). The page's own cases are in web/src/sessions.test.tsx and work.test.tsx.
import { describe, expect, it } from 'vitest';
import { parsePullRequest } from '../prs/parse.js';
import { prNode, reviewRequests, VIEWER } from '../test/prs.js';
import { needsYouReason, ownedPrsBySession, prNeedKind } from './needsYou.js';
import type { SessionSummary } from './protocol.js';

const base: SessionSummary = { sessionId: '22222222-2222-4222-8222-222222222222', name: 'pitwall-test-shared', kind: 'interactive', cwd: '/tmp/pitwall-test-root/repo', alive: true, startedAt: '2026-11-06T00:00:00.000Z', stale: false, finished: false, transcript: 'ok' };
const owner: SessionSummary = { ...base, prLinks: [{ kind: 'opened', repo: 'example/demo-app', number: 3, lastAt: '2026-11-06T09:00:00.000Z' }] };

describe('prNeedKind', () => {
  it('names why a PR needs you, and is undefined when it does not', () => {
    const mine = (overrides: Record<string, unknown>) => parsePullRequest(prNode({ number: 3, ...overrides }))!;
    expect(prNeedKind(mine({ mergeable: 'CONFLICTING' }))).toBe('conflicts');
    expect(prNeedKind(mine({ reviewDecision: 'CHANGES_REQUESTED' }))).toBe('changes-requested');
    expect(prNeedKind(mine({}))).toBeUndefined();
    expect(prNeedKind(parsePullRequest(prNode({ number: 3, reviewRequests: reviewRequests({ team: 'example/reviewers' }) }), 'review-requested', VIEWER)!)).toBe('review-requested');
  });
});

describe('needsYouReason', () => {
  it('is the page\'s own rule: the session or an unbusy PR, the session winning', () => {
    const pr = parsePullRequest(prNode({ number: 3, mergeable: 'CONFLICTING' }))!;
    const owned = ownedPrsBySession([owner], [pr]).get(owner.sessionId);
    expect(owned).toHaveLength(1);
    expect(needsYouReason(owner, owned)).toEqual({ attention: true, pr: { need: 'conflicts', ref: 'example/demo-app#3' }, won: 'pr' });
    expect(needsYouReason({ ...owner, status: 'busy' }, owned)).toEqual({ attention: false });
    expect(needsYouReason({ ...owner, needsYou: { reason: 'recap' } }, owned)).toMatchObject({ attention: true, own: 'recap', won: 'own' });
    expect(needsYouReason({ ...base, needsYou: { reason: 'asked' }, snoozed: { until: '2026-11-07T00:00:00.000Z' } as SessionSummary['snoozed'] }, undefined)).toEqual({ attention: false, setAside: 'snoozed' });
  });
});
