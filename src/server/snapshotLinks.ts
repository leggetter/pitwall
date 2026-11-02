// The snapshot the server sends (D14, W105's review): the index's, with each session's PR links cut
// to those that match a PR in the current PR list (prLinkMatches()). The index keeps every link, so
// when the list changes, the snapshot is sent again with the links that match it now, and the page's
// ownership (prOwner()), Finished and "Mentioned in" lose nothing. Without a PR list, as with
// `--no-prs` or before the first fetch, no link is sent: the page shows only those that match.
//
// Measured on 2026-10-29: carrying every link took the snapshot from 85,367 to 150,330 bytes; most
// were links to PRs that aren't open, and the snapshot is sent again after nearly every 5 s poll
// while a session works.
//
//   GET SNAPSHOT_PATH   view.latest()
//   the WebSocket       view.subscribe(): each index snapshot, as before, and the snapshot again when
//                       a new PR list changes what it carries, never a heartbeat for one that doesn't
import type { Indexer } from '../index/index.js';
import type { PrSource } from '../prs/index.js';
import type { IndexSnapshot, PrLink, PullRequestList } from '../shared/protocol.js';
import { snapshotContent } from './websocket.js';

/** The snapshot as clients get it: GET SNAPSHOT_PATH and the WebSocket. */
export interface SnapshotView extends Pick<Indexer, 'latest' | 'subscribe'> {
  stop(): void;
}

/** What a link is matched by: `repo#number`, and for 'pushed', the head's `repo` and `branch`. */
function keysOf(list: PullRequestList): { numbers: Set<string>; heads: Set<string> } {
  const numbers = new Set<string>();
  const heads = new Set<string>();
  for (const pr of list.prs) {
    numbers.add(`${pr.repo}#${pr.number}`);
    if (pr.head !== undefined) heads.add(`${pr.head.repo}\n${pr.head.branch}`);
  }
  return { numbers, heads };
}

/** prLinkMatches() against every PR in the list at once. */
const matches = (link: PrLink, keys: ReturnType<typeof keysOf>) =>
  link.kind === 'pushed' ? keys.heads.has(`${link.repo}\n${link.branch ?? ''}`) : keys.numbers.has(`${link.repo}#${link.number ?? ''}`);

/**
 * `snapshot` with each session's links cut to those that match a PR in `list`, and a session's
 * `prLinks` left out when none does. The same object when no session has a link to cut, else a copy
 * that shares everything else.
 */
export function withOpenPrLinks(snapshot: IndexSnapshot, list: PullRequestList): IndexSnapshot {
  if (!snapshot.groups.some((group) => group.sessions.some((session) => session.prLinks !== undefined))) return snapshot;
  const keys = keysOf(list);
  return {
    ...snapshot,
    groups: snapshot.groups.map((group) => {
      if (!group.sessions.some((session) => session.prLinks !== undefined)) return group;
      return {
        ...group,
        sessions: group.sessions.map((session) => {
          if (session.prLinks === undefined) return session;
          const { prLinks, ...rest } = session;
          const kept = prLinks.filter((link) => matches(link, keys));
          return kept.length > 0 ? { ...rest, prLinks: kept } : rest;
        }),
      };
    }),
  };
}

/**
 * The index's snapshots, each with only the links that match the PR list. Each listener has its own
 * subscriptions to the index and the PR list, made when it subscribes and dropped when it
 * unsubscribes, so the index's listeners are its clients, as before.
 */
export function createSnapshotView(indexer: Pick<Indexer, 'latest' | 'subscribe'>, prs: Pick<PrSource, 'latest' | 'subscribe'>): SnapshotView {
  let cached: { snapshot: IndexSnapshot; list: PullRequestList; view: IndexSnapshot } | undefined;
  const active = new Set<() => void>();

  function viewOf(snapshot: IndexSnapshot): IndexSnapshot {
    const list = prs.latest();
    if (cached !== undefined && cached.snapshot === snapshot && cached.list === list) return cached.view;
    const view = withOpenPrLinks(snapshot, list);
    cached = { snapshot, list, view };
    return view;
  }

  function latest(): IndexSnapshot | undefined {
    const snapshot = indexer.latest();
    return snapshot === undefined ? undefined : viewOf(snapshot);
  }

  return {
    latest,
    subscribe(listener) {
      // What this listener last got, without generatedAt: a subscriber reads latest() just before,
      // as the WebSocket does, so that's where it starts.
      const current = latest();
      let told = current === undefined ? undefined : snapshotContent(current);
      const pass = (view: IndexSnapshot) => {
        told = snapshotContent(view);
        listener(view);
      };
      // Every poll, changed or not, as the index tells: the WebSocket sends a heartbeat for one that isn't.
      const offIndex = indexer.subscribe((snapshot) => pass(viewOf(snapshot)));
      // A new PR list: the snapshot again, only when what it carries changed, and only to a
      // listener that has had one.
      const offPrs = prs.subscribe(() => {
        const view = latest();
        if (view !== undefined && told !== undefined && snapshotContent(view) !== told) pass(view);
      });
      const unsubscribe = () => {
        offIndex();
        offPrs();
        active.delete(unsubscribe);
      };
      active.add(unsubscribe);
      return unsubscribe;
    },
    stop() {
      for (const unsubscribe of [...active]) unsubscribe();
    },
  };
}
