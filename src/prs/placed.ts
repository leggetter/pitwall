// The PR list with every PR placed (M4 redesign, W105): a PrSource around the poller's that adds
// PullRequestSummary.place to each PR and PullRequestList.roots to the list (place.ts), from the
// repos under the snapshot's roots (index/repos.ts) and the config file's owners (W103).
//
//   when       recomputed when the poller's list changes, when the roots change, and when the
//              repos do: a discovery or a read that finds different remotes. Listeners hear of a
//              new list only when its content changed, and latest() keeps one object until then
//   the index  each snapshot hands discovery its roots and the repos it knows: its git groups and
//              the repos its sessions worked in, wherever they are. That's cheap, and runs no git
//   start()    starts the poller and, from the index's next snapshot, discovery. Nothing runs before
//   refresh()  the poller's, and when a fetch starts, a discovery too, so a repo cloned since is found
//   rediscover()  a discovery alone, once started, with no fetch: after W107's clone, so its PRs move
//              from 'not-cloned' to 'cloned' without a call to GitHub
//   stop()     stops the poller and discovery
//
// Never logs: repo names and paths are as sensitive as session data.
import os from 'node:os';
import type { Indexer } from '../index/index.js';
import { createRepoDiscovery, type RepoDiscovery } from '../index/repos.js';
import type { IndexSnapshot, PullRequestList } from '../shared/protocol.js';
import { placePullRequests, type OwnersByRoot } from './place.js';
import type { PrSource } from './poller.js';

export interface PlacementOptions {
  /** The index, whose snapshots give the roots and the repos sessions know. */
  index: Pick<Indexer, 'latest' | 'subscribe'>;
  /** Which owners each configured root claims, from the config file (W103). */
  ownersByRoot?: OwnersByRoot;
  /** The repo discovery. Default createRepoDiscovery(). */
  repos?: RepoDiscovery;
  /** For labels outside their root, shown with `~`. Default os.homedir(). */
  home?: string;
}

/** The repos a snapshot knows, with their roots: its git groups, and every repo a session worked in. */
export function knownRepos(snapshot: IndexSnapshot): { key: string; root: string }[] {
  const known: { key: string; root: string }[] = [];
  for (const group of snapshot.groups) {
    if (group.kind === 'git') known.push({ key: group.key, root: group.root });
    for (const session of group.sessions) for (const repo of session.workedIn ?? []) known.push({ key: repo.key, root: repo.root });
  }
  return known;
}

const sameRoots = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((root, i) => root === b[i]);

/** `source` with every PR placed and the roots' owners added. */
export function withPlaces(source: PrSource, options: PlacementOptions): PrSource {
  const repos = options.repos ?? createRepoDiscovery();
  const home = options.home ?? os.homedir();
  let roots: string[] = [];
  /** Bumped when the roots or the repos change. */
  let version = 0;
  let cached: { inner: PullRequestList; version: number; placed: PullRequestList; content: string } | undefined;
  let told: string | undefined;
  const listeners = new Set<(list: PullRequestList) => void>();
  const unsubscribes: (() => void)[] = [];
  let started = false;
  let stopped = false;

  function latest(): PullRequestList {
    const inner = source.latest();
    if (cached !== undefined && cached.inner === inner && cached.version === version) return cached.placed;
    const placed = placePullRequests(inner, roots, repos.repos(), options.ownersByRoot, home);
    const content = JSON.stringify(placed);
    // The same content keeps its object, so it's serialised once (websocket.ts).
    if (cached !== undefined && cached.content === content) {
      cached = { ...cached, inner, version };
      return cached.placed;
    }
    cached = { inner, version, placed, content };
    return placed;
  }

  function tell(): void {
    if (stopped) return;
    const list = latest();
    if (cached?.content === told) return;
    told = cached?.content;
    for (const listener of [...listeners]) {
      try {
        listener(list);
      } catch {
        // One listener's failure, such as a socket that closed, mustn't stop the others.
      }
    }
  }

  function onSnapshot(snapshot: IndexSnapshot): void {
    try {
      if (!sameRoots(roots, snapshot.roots)) {
        roots = [...snapshot.roots];
        version++;
      }
      repos.update(roots, knownRepos(snapshot));
      tell();
    } catch {
      // A snapshot that can't be read leaves the places as they were.
    }
  }

  // The poller's lists, from the start, so a refresh before start() is placed too.
  unsubscribes.push(source.subscribe(() => tell()));

  return {
    latest,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh() {
      const result = source.refresh();
      if (result.kind === 'started' && started) repos.refresh();
      return result;
    },
    rediscover() {
      if (started && !stopped) repos.refresh();
    },
    start() {
      if (started || stopped) return;
      started = true;
      unsubscribes.push(
        repos.subscribe(() => {
          version++;
          tell();
        }),
        options.index.subscribe(onSnapshot),
      );
      const snapshot = options.index.latest();
      if (snapshot !== undefined) onSnapshot(snapshot);
      source.start();
    },
    stop() {
      stopped = true;
      for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
      listeners.clear();
      repos.stop();
      source.stop();
    },
  };
}
