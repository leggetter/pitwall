// Where each PR is listed (place.ts, W105). Every repo, owner, path and PR here is made up.
import { describe, expect, it } from 'vitest';
import type { LocalRepo } from '../index/repos.js';
import type { PullRequestList, PullRequestSummary, RootOwners } from '../shared/protocol.js';
import { prNode } from '../test/prs.js';
import { claimingRoot, cloneIndex, placeOf, placePullRequests, rootOwners, type OwnersByRoot } from './place.js';
import { parsePullRequest } from './parse.js';

const HOME = '/home/someone';
const WORK = '/home/someone/work';
const OSS = '/home/someone/oss';
const ROOTS = [WORK, OSS];

/** A clone, with its remotes as `name=owner/repo`. */
const clone = (key: string, root: string, ...remotes: string[]): LocalRepo => ({
  key,
  root,
  remotes: remotes.map((remote) => {
    const [name = '', slug = ''] = remote.split('=');
    return { name, slug };
  }),
});

const pr = (repo: string, number = 1, overrides: Record<string, unknown> = {}): PullRequestSummary =>
  parsePullRequest(prNode({ repo, number, ...overrides }))!;

describe('rootOwners', () => {
  it('without config, gives each owner to the root with the most clones of it, the first root on a tie', () => {
    const repos = [
      clone(`${WORK}/a`, WORK, 'origin=example-org/a'),
      clone(`${WORK}/b`, WORK, 'origin=example-org/b'),
      clone(`${WORK}/c`, WORK, 'origin=someone/c'),
      clone(`${OSS}/d`, OSS, 'origin=someone/d'),
      clone(`${OSS}/e`, OSS, 'origin=someone/e'),
      clone(`${OSS}/f`, OSS, 'origin=example-org/f'),
      // One each: the tie goes to the first root given.
      clone(`${WORK}/g`, WORK, 'origin=example-tie/g'),
      clone(`${OSS}/h`, OSS, 'origin=example-tie/h'),
      // A clone counts once for each owner its remotes name, however many remotes name it.
      clone(`${OSS}/i`, OSS, 'origin=example-fork/i', 'upstream=example-fork/i-old', 'up=example-up/i'),
    ];
    expect(rootOwners(ROOTS, repos)).toEqual<RootOwners[]>([
      { root: WORK, owners: ['example-org', 'example-tie'], source: 'clones' },
      { root: OSS, owners: ['example-fork', 'example-up', 'someone'], source: 'clones' },
    ]);
    expect(rootOwners([OSS, WORK], repos).find((r) => r.root === OSS)?.owners).toContain('example-tie');
  });

  it('is every root, with no owners, when there are no clones, and leaves out clones under no root it was given', () => {
    expect(rootOwners(ROOTS, [clone('/elsewhere/x', '/elsewhere', 'origin=example/x')])).toEqual([
      { root: WORK, owners: [], source: 'clones' },
      { root: OSS, owners: [], source: 'clones' },
    ]);
    expect(rootOwners([], [])).toEqual([]);
  });

  it("gives a configured root its config, lowercase and each once, and infers no owner a configured list names", () => {
    const repos = [clone(`${OSS}/a`, OSS, 'origin=example-org/a'), clone(`${OSS}/b`, OSS, 'origin=someone/b')];
    const config: OwnersByRoot = new Map([[WORK, ['Example-Org', 'example-org', 'not an owner', 'another-org']]]);
    expect(rootOwners(ROOTS, repos, config)).toEqual<RootOwners[]>([
      { root: WORK, owners: ['example-org', 'another-org'], source: 'config' },
      { root: OSS, owners: ['someone'], source: 'clones' },
    ]);
  });

  it("lets a root configured 'all' or 'none' take no part in inference, so its clones' owners can go to another root", () => {
    const repos = [
      clone(`${WORK}/a`, WORK, 'origin=example-org/a'),
      clone(`${WORK}/b`, WORK, 'origin=example-org/b'),
      clone(`${OSS}/c`, OSS, 'origin=example-org/c'),
    ];
    for (const value of ['all', 'none'] as const) {
      expect(rootOwners(ROOTS, repos, new Map([[WORK, value]]))).toEqual<RootOwners[]>([
        { root: WORK, owners: value, source: 'config' },
        { root: OSS, owners: ['example-org'], source: 'clones' },
      ]);
    }
    // A root the config names that isn't one of the roots changes nothing.
    expect(rootOwners(ROOTS, repos, new Map([['/home/someone/other', 'all']]))).toEqual(rootOwners(ROOTS, repos));
  });
});

describe('claimingRoot', () => {
  const owners: RootOwners[] = [
    { root: '/a', owners: 'all', source: 'config' },
    { root: '/b', owners: ['example-org'], source: 'clones' },
    { root: '/c', owners: ['example-org', 'example-listed'], source: 'config' },
    { root: '/d', owners: 'none', source: 'config' },
    { root: '/e', owners: ['example-listed'], source: 'config' },
  ];

  it("is the first root whose configured list names the owner, else the one inferred for it, else the first 'all'", () => {
    expect(claimingRoot('example-listed', owners)).toBe('/c');
    expect(claimingRoot('Example-Org', owners)).toBe('/c');
    expect(claimingRoot('example-org', owners.filter((r) => r.root !== '/c'))).toBe('/b');
    expect(claimingRoot('anyone-else', owners)).toBe('/a');
  });

  it("is nothing when no root lists the owner and none is 'all': 'none' claims nothing", () => {
    expect(claimingRoot('anyone-else', owners.filter((r) => r.owners !== 'all'))).toBeUndefined();
    expect(claimingRoot('anyone', [])).toBeUndefined();
  });
});

describe('placeOf', () => {
  const owners = rootOwners(ROOTS, [clone(`${WORK}/x`, WORK, 'origin=example-org/x')], new Map([[OSS, ['someone']]]));
  const place = (p: PullRequestSummary, repos: LocalRepo[]) => placeOf(p, cloneIndex(repos), owners, HOME);

  it("is 'cloned' in a repo with any remote for the PR's repo, with its key, root and group label", () => {
    const repos = [clone(`${WORK}/tools/demo-app`, WORK, 'origin=someone/demo-app-fork', 'upstream=example/demo-app')];
    expect(place(pr('example/demo-app'), repos)).toEqual({ kind: 'cloned', root: WORK, key: `${WORK}/tools/demo-app`, label: 'tools/demo-app' });
  });

  it("is 'cloned' in a clone of the head's repo, a fork's, only when there's none of the PR's own", () => {
    const fork = clone(`${OSS}/demo-app`, OSS, 'origin=someone/demo-app');
    const head = { headRepository: { nameWithOwner: 'someone/demo-app' } };
    expect(place(pr('example/demo-app', 1, head), [fork])).toMatchObject({ kind: 'cloned', key: `${OSS}/demo-app` });
    const upstream = clone(`${WORK}/upstream-app`, WORK, 'origin=example/demo-app');
    expect(place(pr('example/demo-app', 1, head), [fork, upstream])).toMatchObject({ kind: 'cloned', key: `${WORK}/upstream-app` });
  });

  it('with several clones, takes the one named like the repo, then the one whose origin it is, then the first by path', () => {
    const named = clone(`${WORK}/zz/demo-app`, WORK, 'upstream=example/demo-app');
    const origin = clone(`${WORK}/aa/old-name`, WORK, 'origin=example/demo-app');
    const other = clone(`${WORK}/aa/another`, WORK, 'upstream=example/demo-app');
    const both = clone(`${WORK}/zz/z/Demo-App`, WORK, 'origin=example/demo-app');
    expect(place(pr('example/demo-app'), [other, origin, named])).toMatchObject({ key: named.key });
    expect(place(pr('example/demo-app'), [other, origin, named, both])).toMatchObject({ key: both.key });
    expect(place(pr('example/demo-app'), [other, origin])).toMatchObject({ key: origin.key });
    expect(place(pr('example/demo-app'), [clone(`${WORK}/b`, WORK, 'up=example/demo-app'), other])).toMatchObject({ key: other.key });
  });

  it("labels a clone outside its root as grouping.ts does, with the home directory as ~", () => {
    expect(place(pr('example/demo-app'), [clone('/home/someone/elsewhere/demo-app', WORK, 'origin=example/demo-app')])).toMatchObject({
      root: WORK,
      label: '~/elsewhere/demo-app',
    });
  });

  it("is 'not-cloned' with the root that claims the owner, and 'unclaimed' when none does", () => {
    expect(place(pr('example-org/y'), [])).toEqual({ kind: 'not-cloned', root: WORK });
    expect(place(pr('someone/z'), [])).toEqual({ kind: 'not-cloned', root: OSS });
    expect(place(pr('stranger/z'), [])).toEqual({ kind: 'unclaimed' });
    // The head's owner doesn't claim it.
    expect(place(pr('stranger/z', 1, { headRepository: { nameWithOwner: 'someone/z' } }), [])).toEqual({ kind: 'unclaimed' });
  });

  it("is 'cloned' whatever its root's owners say: a root configured 'none' still lists its clones' PRs", () => {
    const none = rootOwners(ROOTS, [], new Map([[WORK, 'none'], [OSS, 'none']]));
    expect(placeOf(pr('stranger/z'), cloneIndex([clone(`${WORK}/z`, WORK, 'origin=stranger/z')]), none, HOME)).toMatchObject({ kind: 'cloned', root: WORK });
  });
});

describe('placePullRequests', () => {
  const list = (prs: PullRequestSummary[]): PullRequestList => ({ fetchedAt: '2026-10-29T12:00:00.000Z', source: { ok: true }, refreshing: false, prs });

  it('places every PR, as copies, and adds the roots’ owners, leaving the rest as it was', () => {
    const prs = [pr('example/demo-app', 1), pr('example/other', 2), pr('stranger/x', 3)];
    const given = list(prs);
    const placed = placePullRequests(given, ROOTS, [clone(`${WORK}/demo-app`, WORK, 'origin=example/demo-app')], undefined, HOME);
    expect(placed).toEqual({
      ...given,
      prs: [
        { ...prs[0], place: { kind: 'cloned', root: WORK, key: `${WORK}/demo-app`, label: 'demo-app' } },
        { ...prs[1], place: { kind: 'not-cloned', root: WORK } },
        { ...prs[2], place: { kind: 'unclaimed' } },
      ],
      roots: [
        { root: WORK, owners: ['example'], source: 'clones' },
        { root: OSS, owners: [], source: 'clones' },
      ],
    });
    expect(given.prs[0]).not.toHaveProperty('place');
    expect(given).not.toHaveProperty('roots');
  });

  it('places with no roots and no repos too: each PR unclaimed', () => {
    expect(placePullRequests(list([pr('example/demo-app')]), [], [], undefined, HOME)).toMatchObject({ prs: [{ place: { kind: 'unclaimed' } }], roots: [] });
  });

  it("returns the 'off' list as it is", () => {
    const off: PullRequestList = { source: { ok: false, reason: 'off', error: 'off' }, refreshing: false, prs: [] };
    expect(placePullRequests(off, ROOTS, [], undefined, HOME)).toBe(off);
  });
});
