// The contract's own rules, where they're more than a type: which session owns a PR (W104).
import { describe, expect, it } from 'vitest';
import { prLinkRank, prOwner, type PrLink, type PullRequestSummary } from './protocol.js';

const pr: PullRequestSummary = {
  url: 'https://github.com/example/web/pull/128',
  repo: 'example/web',
  repoLabel: 'example/web',
  number: 128,
  title: 'Split the billing client',
  draft: false,
  createdAt: '2026-10-20T10:00:00.000Z',
  updatedAt: '2026-10-29T10:00:00.000Z',
  head: { repo: 'example/web', branch: 'billing-client' },
  checks: 'passing',
  mergeable: 'clean',
  relation: 'authored',
};

const at = (minute: number) => new Date(Date.UTC(2026, 9, 29, 9, minute)).toISOString();
const numbered = (kind: PrLink['kind'], minute: number, number = 128): PrLink => ({ kind, repo: 'example/web', number, lastAt: at(minute) });
const pushed = (minute: number, branch = 'billing-client'): PrLink => ({ kind: 'pushed', repo: 'example/web', branch, lastAt: at(minute) });
const session = (sessionId: string, ...prLinks: PrLink[]) => ({ sessionId, prLinks });

describe('prLinkRank', () => {
  it('ranks acting on a PR over being given its link, and a mention never owns', () => {
    expect(prLinkRank(numbered('opened', 0))).toBe(2);
    expect(prLinkRank(pushed(0))).toBe(2);
    expect(prLinkRank(numbered('linked', 0))).toBe(2);
    expect(prLinkRank(numbered('prompted', 0))).toBe(1);
    expect(prLinkRank(numbered('mentioned', 0))).toBe(0);
  });
});

describe('prOwner', () => {
  it('is the session that acted on the PR last', () => {
    const opener = session('a', numbered('opened', 0));
    const pusher = session('b', pushed(30));
    expect(prOwner(pr, [opener, pusher])).toBe(pusher);
    expect(prOwner(pr, [pusher, opener])).toBe(pusher);
  });

  it('counts Claude Code’s own link as acting on it', () => {
    const opener = session('a', numbered('opened', 0));
    const linker = session('b', numbered('linked', 10));
    expect(prOwner(pr, [opener, linker])).toBe(linker);
  });

  it('lets a prompted link own only when no session acted on the PR', () => {
    const prompted = session('a', numbered('prompted', 50));
    const opener = session('b', numbered('opened', 0));
    expect(prOwner(pr, [prompted, opener])).toBe(opener);
    expect(prOwner(pr, [prompted])).toBe(prompted);
  });

  it('never makes a mention the owner', () => {
    expect(prOwner(pr, [session('a', numbered('mentioned', 0))])).toBeUndefined();
  });

  it('uses each session’s best link to this PR, and ignores links to other PRs', () => {
    const other = session('a', numbered('opened', 59, 131), numbered('prompted', 1));
    const opener = session('b', numbered('opened', 0));
    expect(prOwner(pr, [other, opener])).toBe(opener);
    expect(prOwner(pr, [session('c', pushed(59, 'another-branch'))])).toBeUndefined();
  });

  it('breaks a tie by session id, so the owner never flips between polls', () => {
    const b = session('b', numbered('opened', 0));
    const a = session('a', numbered('linked', 0));
    expect(prOwner(pr, [b, a])).toBe(a);
    expect(prOwner(pr, [a, b])).toBe(a);
  });

  it('reads a bad time as the oldest, and a session without links as none', () => {
    const bad = session('a', { ...numbered('opened', 0), lastAt: 'not a time' });
    const good = session('b', numbered('opened', 0));
    expect(prOwner(pr, [bad, good])).toBe(good);
    expect(prOwner(pr, [{ sessionId: 'c' }])).toBeUndefined();
  });
});
