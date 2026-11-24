// The Needs you rules the page and the server share (W165). The page's own cases are in web/src/sessions.test.tsx and work.test.tsx.
import { describe, expect, it } from 'vitest';
import { parsePullRequest } from '../prs/parse.js';
import { prNode, reviewRequests, VIEWER } from '../test/prs.js';
import { needsYouReason, ownedPrsBySession, prHeldBy, prNeedKind, prNeedOf, prWakeOf } from './needsYou.js';
import type { PullRequestSummary, SessionSummary } from './protocol.js';

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

describe('a snooze holds the PR (W199)', () => {
  const HASH = '0123456789abcdef';
  const OTHER_HASH = 'fedcba9876543210';
  const conflicts = (overrides: Partial<PullRequestSummary> = {}) => ({ ...parsePullRequest(prNode({ number: 3, mergeable: 'CONFLICTING' }))!, stateHash: HASH, ...overrides });
  const held = { at: '2026-11-06T09:00:00.000Z', heldPrs: [{ key: 'example/demo-app#3', stateHash: HASH }] };
  const snoozed: SessionSummary = { ...owner, needsYou: { reason: 'recap' }, snoozed: held };

  it('keeps a held PR from putting the row in Needs you, while its hash is the same', () => {
    expect(prHeldBy(held, conflicts())).toBe(true);
    expect(prNeedOf(snoozed, [conflicts()])).toBeUndefined();
    expect(needsYouReason(snoozed, [conflicts()])).toEqual({ attention: false, setAside: 'snoozed' });
  });

  it('does not hold one with something new, no hash now, or one it never recorded; a snooze without hashes holds none', () => {
    expect(prNeedOf(snoozed, [conflicts({ stateHash: OTHER_HASH })])).toBeDefined();
    expect(prNeedOf(snoozed, [conflicts({ stateHash: undefined })])).toBeDefined();
    expect(prNeedOf(snoozed, [conflicts({ number: 4 })])).toBeDefined();
    expect(prNeedOf({ ...snoozed, snoozed: { at: held.at } }, [conflicts()])).toBeDefined();
    expect(prNeedOf({ ...snoozed, snoozed: { ...held, heldPrs: [{ ...held.heldPrs[0]!, redHash: 'aaaaaaaaaaaaaaaa' }] } }, [conflicts({ redHash: 'bbbbbbbbbbbbbbbb' })])).toBeDefined();
  });

  it('wakes on a changed or new PR, never on one with no hash, and not while busy', () => {
    expect(prWakeOf(snoozed, held, [conflicts()])).toBeUndefined();
    expect(prWakeOf(snoozed, held, [conflicts({ stateHash: OTHER_HASH })])).toEqual({ ref: 'example/demo-app#3', need: 'conflicts' });
    expect(prWakeOf(snoozed, held, [conflicts(), conflicts({ number: 4 })])).toEqual({ ref: 'example/demo-app#4', need: 'conflicts' });
    expect(prWakeOf(snoozed, held, [conflicts({ stateHash: undefined })])).toBeUndefined();
    expect(prWakeOf({ ...snoozed, status: 'busy' }, held, [conflicts({ stateHash: OTHER_HASH })])).toBeUndefined();
    expect(prWakeOf(snoozed, { at: held.at }, [conflicts({ stateHash: OTHER_HASH })])).toBeUndefined();
  });
});
