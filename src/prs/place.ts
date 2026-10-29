// Where each PR is listed (M4 redesign, W105): under the clone of its repo, under the root that
// claims its owner, or nowhere. Pure: the repos come from discovery (index/repos.ts), the roots
// from the snapshot, and the owners each root claims from the config file (W103).
//
//   owners      rootOwners(): which GitHub owners each root claims (RootOwners), for PRs in repos
//               it has no clone of
//     config    a root in ownersByRoot gets its value: a list, 'all' or 'none' (source 'config')
//     clones    every other root infers its own (source 'clones'): each owner goes to the root,
//               among those, with the most clones whose remotes point at it, the first root given
//               winning a tie (Phil, 2026-10-29). A clone counts once for each owner its remotes
//               name. An owner a configured list names is never inferred, so the config wins; a
//               root configured 'none' or 'all', or with a list, takes no part, so its clones'
//               owners can go to another root with clones of them
//   claims      claimingRoot(): an owner is claimed by the first root whose configured list names
//               it, else the root it was inferred to, else the first root configured 'all': a
//               listed owner wins over 'all', as RootOwners says. 'none' claims nothing
//   placing     placeOf(), for every PR, whether or not a session owns it (prOwner() is the web UI's):
//     cloned      a repo with a remote for the PR's repo, or failing that for its head's repo, a
//                 fork's clone. With several, the one whose directory is named like the repo, then
//                 the one whose `origin` points at it, then the first by path. A clone places its
//                 PRs whatever its root's owners say: 'none' still lists its clones'
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

  // Clones per owner, per root that infers its owners.
  const counts = new Map<string, Map<string, number>>();
  for (const repo of repos) {
    if (config.has(repo.root) || !roots.includes(repo.root)) continue;
    for (const owner of new Set(repo.remotes.map((remote) => ownerOf(remote.slug)))) {
      if (listed.has(owner)) continue;
      let perRoot = counts.get(owner);
      if (perRoot === undefined) counts.set(owner, (perRoot = new Map()));
      perRoot.set(repo.root, (perRoot.get(repo.root) ?? 0) + 1);
    }
  }
  const inferred = new Map<string, string[]>();
  for (const [owner, perRoot] of counts) {
    let best: string | undefined;
    for (const root of roots) {
      const count = perRoot.get(root) ?? 0;
      if (count > 0 && (best === undefined || count > (perRoot.get(best) ?? 0))) best = root;
    }
    if (best === undefined) continue;
    const owners = inferred.get(best) ?? [];
    owners.push(owner);
    inferred.set(best, owners);
  }

  return roots.map((root): RootOwners => {
    const value = config.get(root);
    if (value !== undefined) return { root, owners: Array.isArray(value) ? [...value] : value, source: 'config' };
    return { root, owners: (inferred.get(root) ?? []).sort(), source: 'clones' };
  });
}

/**
 * The root that claims `owner`, lowercase, for a PR in a repo with no clone: the first whose
 * configured list names it, else the one inferred for it, else the first configured 'all'.
 */
export function claimingRoot(owner: string, owners: readonly RootOwners[]): string | undefined {
  const lower = owner.toLowerCase();
  const listing = (source: RootOwners['source']) => owners.find((each) => each.source === source && Array.isArray(each.owners) && each.owners.includes(lower));
  return (listing('config') ?? listing('clones') ?? owners.find((each) => each.owners === 'all'))?.root;
}

/** The repos with a remote for each GitHub repo, lowercase `owner/name`, for placeOf(). */
export type CloneIndex = ReadonlyMap<string, readonly LocalRepo[]>;

export function cloneIndex(repos: readonly LocalRepo[]): CloneIndex {
  const index = new Map<string, LocalRepo[]>();
  for (const repo of repos) {
    for (const slug of new Set(repo.remotes.map((remote) => remote.slug))) {
      const list = index.get(slug) ?? [];
      list.push(repo);
      index.set(slug, list);
    }
  }
  return index;
}

/** Of the clones of `slug`, the one named like it, then the one whose origin is it, then the first by path. */
function bestClone(slug: string, clones: readonly LocalRepo[]): LocalRepo | undefined {
  const name = slug.slice(slug.indexOf('/') + 1);
  const rank = (repo: LocalRepo) =>
    (path.basename(repo.key).toLowerCase() === name ? 0 : 2) + (repo.remotes.some((remote) => remote.name === 'origin' && remote.slug === slug) ? 0 : 1);
  let best: LocalRepo | undefined;
  for (const repo of clones) {
    if (best === undefined) best = repo;
    else {
      const diff = rank(repo) - rank(best);
      if (diff < 0 || (diff === 0 && repo.key < best.key)) best = repo;
    }
  }
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
  const clones = cloneIndex(repos);
  return { ...list, prs: list.prs.map((pr) => ({ ...pr, place: placeOf(pr, clones, owners, home) })), roots: owners };
}
