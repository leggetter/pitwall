// Where each PR is listed (M4 redesign, W105): under the clone of its repo, under the root that
// claims its owner, or nowhere. Pure: the repos come from discovery (index/repos.ts), the roots
// from the snapshot, and the owners each root claims from the config file (W103).
//
//   owners      which root claims each GitHub owner, for PRs in repos no root has a clone of
//               (Phil, 2026-10-29: each owner goes to the root with the most clones from it, and
//               the config file overrides that; the rule as the coordinator set it in W105's review):
//     1. listed   an owner a configured list names goes to that root, the first given if two do
//     2. clones   otherwise, every root's clones of it are counted, a clone once for each owner its
//                 remotes name, and the root with the most claims it, unless its config is 'none'
//                 or a list that doesn't name it: then the next root by count that would claim it
//                 does, an unconfigured one or one configured 'all'
//     3. 'all'    otherwise, the first root configured 'all'
//     ties        by the order the roots were given
//   RootOwners  rootOwners(), one per root: a configured root's value (source 'config'), and an
//               unconfigured root's owners from step 2 (source 'clones'). An owner step 2 gives a
//               root configured 'all' is in no list: claimingRoot() reaches it at step 3, as the
//               config file allows one root with 'all'
//   placing     placeOf(), for every PR, whether or not a session owns it (prOwner() is the web UI's):
//     cloned      a repo with a remote for the PR's repo, or failing that for its head's repo, a
//                 fork's clone. With several, the one whose directory is named like the repo, then
//                 the one whose `origin` points at it, then the one under the first root given,
//                 then the first by path. A clone places its PRs whatever its root's owners say:
//                 'none' still lists its clones'
//     not-cloned  no clone, and a root claims the repo's owner
//     unclaimed   neither
//   labels      the key and label as grouping.ts gives a group: groupLabel(key, root, home)

import path from 'node:path';
import { groupLabel } from '../index/grouping.js';
import type { LocalRepo } from '../index/repos.js';
import { GITHUB_OWNER_PATTERN, type PullRequestList, type PullRequestPlace, type PullRequestSummary, type RootOwners } from '../shared/protocol.js';

/**
 * Which GitHub owners each root claims, from the config file (W103), keyed by real-path root: a
 * list of owners, 'all' for any owner no other root lists, or 'none' for its clones only.
 */
export type OwnersByRoot = ReadonlyMap<string, string[] | 'all' | 'none'>;

const OWNER = new RegExp(`^${GITHUB_OWNER_PATTERN}$`);

/** A configured list's owners: lowercase, each once, in order, without any that can't be an owner. */
function configuredOwners(owners: readonly unknown[]): string[] {
  const kept: string[] = [];
  for (const owner of owners) {
    if (typeof owner !== 'string' || !OWNER.test(owner)) continue;
    const lower = owner.toLowerCase();
    if (!kept.includes(lower)) kept.push(lower);
  }
  return kept;
}

const ownerOf = (slug: string) => slug.slice(0, slug.indexOf('/'));

/** Which owners each root claims (RootOwners), one per root, in the order given. */
export function rootOwners(roots: readonly string[], repos: readonly LocalRepo[], ownersByRoot?: OwnersByRoot): RootOwners[] {
  const config = new Map<string, string[] | 'all' | 'none'>();
  for (const root of roots) {
    const value = ownersByRoot?.get(root);
    if (value === 'all' || value === 'none') config.set(root, value);
    else if (Array.isArray(value)) config.set(root, configuredOwners(value));
  }
  const listed = new Set<string>();
  for (const value of config.values()) if (Array.isArray(value)) for (const owner of value) listed.add(owner);

  // Clones per owner, per root: every root's.
  const counts = new Map<string, Map<string, number>>();
  for (const repo of repos) {
    if (!roots.includes(repo.root)) continue;
    for (const owner of new Set(repo.remotes.map((remote) => ownerOf(remote.slug)))) {
      let perRoot = counts.get(owner);
      if (perRoot === undefined) counts.set(owner, (perRoot = new Map()));
      perRoot.set(repo.root, (perRoot.get(repo.root) ?? 0) + 1);
    }
  }
  // Step 2: the root with the most clones that would claim the owner, ties by the roots' order.
  const inferred = new Map<string, string[]>();
  for (const [owner, perRoot] of counts) {
    if (listed.has(owner)) continue;
    const byCount = roots.filter((root) => (perRoot.get(root) ?? 0) > 0).sort((a, b) => (perRoot.get(b) ?? 0) - (perRoot.get(a) ?? 0));
    const winner = byCount.find((root) => {
      const value = config.get(root);
      return value === undefined || value === 'all';
    });
    if (winner === undefined || config.has(winner)) continue;
    const owners = inferred.get(winner) ?? [];
    owners.push(owner);
    inferred.set(winner, owners);
  }

  return roots.map((root): RootOwners => {
    const value = config.get(root);
    if (value !== undefined) return { root, owners: Array.isArray(value) ? [...value] : value, source: 'config' };
    return { root, owners: (inferred.get(root) ?? []).sort(), source: 'clones' };
  });
}

/**
 * The root that claims `owner`, lowercase, for a PR in a repo with no clone: the first whose
 * configured list names it, else the one rootOwners() gave it from the clones, else the first
 * configured 'all'.
 */
export function claimingRoot(owner: string, owners: readonly RootOwners[]): string | undefined {
  const lower = owner.toLowerCase();
  const listing = (source: RootOwners['source']) => owners.find((each) => each.source === source && Array.isArray(each.owners) && each.owners.includes(lower));
  return (listing('config') ?? listing('clones') ?? owners.find((each) => each.owners === 'all'))?.root;
}

/** The repos with a remote for each GitHub repo, lowercase `owner/name`, for placeOf(). */
export type CloneIndex = ReadonlyMap<string, readonly LocalRepo[]>;

/** Each GitHub repo's clones, under the first root given first, then by path, for bestClone()'s ties. */
export function cloneIndex(repos: readonly LocalRepo[], roots: readonly string[] = []): CloneIndex {
  const order = (repo: LocalRepo) => {
    const at = roots.indexOf(repo.root);
    return at === -1 ? roots.length : at;
  };
  const sorted = [...repos].sort((a, b) => order(a) - order(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const index = new Map<string, LocalRepo[]>();
  for (const repo of sorted) {
    for (const slug of new Set(repo.remotes.map((remote) => remote.slug))) {
      const list = index.get(slug) ?? [];
      list.push(repo);
      index.set(slug, list);
    }
  }
  return index;
}

/**
 * Of the clones of `slug`, the one named like it, then the one whose origin is it, then the first
 * in `clones`, which cloneIndex() orders by root, then path.
 */
function bestClone(slug: string, clones: readonly LocalRepo[]): LocalRepo | undefined {
  const name = slug.slice(slug.indexOf('/') + 1);
  const rank = (repo: LocalRepo) =>
    (path.basename(repo.key).toLowerCase() === name ? 0 : 2) + (repo.remotes.some((remote) => remote.name === 'origin' && remote.slug === slug) ? 0 : 1);
  let best: LocalRepo | undefined;
  for (const repo of clones) if (best === undefined || rank(repo) < rank(best)) best = repo;
  return best;
}

/** Where `pr` is listed (PullRequestPlace). */
export function placeOf(pr: PullRequestSummary, clones: CloneIndex, owners: readonly RootOwners[], home: string): PullRequestPlace {
  const slugs = pr.head !== undefined && pr.head.repo !== pr.repo ? [pr.repo, pr.head.repo] : [pr.repo];
  for (const slug of slugs) {
    const clone = bestClone(slug, clones.get(slug) ?? []);
    if (clone !== undefined) return { kind: 'cloned', root: clone.root, key: clone.key, label: groupLabel(clone.key, clone.root, home) };
  }
  const root = claimingRoot(ownerOf(pr.repo), owners);
  return root === undefined ? { kind: 'unclaimed' } : { kind: 'not-cloned', root };
}

/**
 * `list` with every PR placed and the roots' owners (PullRequestList.roots), as a new list; the PRs
 * are copies. The 'off' list, with `--no-prs`, is returned as it is.
 */
export function placePullRequests(list: PullRequestList, roots: readonly string[], repos: readonly LocalRepo[], ownersByRoot: OwnersByRoot | undefined, home: string): PullRequestList {
  if (!list.source.ok && list.source.reason === 'off') return list;
  const owners = rootOwners(roots, repos, ownersByRoot);
  const clones = cloneIndex(repos, roots);
  return { ...list, prs: list.prs.map((pr) => ({ ...pr, place: placeOf(pr, clones, owners, home) })), roots: owners };
}
