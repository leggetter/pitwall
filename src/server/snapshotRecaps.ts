// The snapshot with recaps (M5, W110): the index's, with each session as the recap engine decorates
// it (RecapEngine.decorate(): its `recap`, its title from the recap, and Needs you's 'recap'
// reason), each group re-sorted when a session's Needs you changed, and the snapshot's `recaps`
// health. W105's view (snapshotLinks.ts) is composed on top of this one, so GET SNAPSHOT_PATH and
// the WebSocket get both:
//
//   index  ->  createRecapView()  ->  createSnapshotView()  ->  clients
//
// Like W105's, it passes every index snapshot on, and sends the snapshot again when a recap lands
// and changes what it carries, never a heartbeat for one that doesn't. Without the engine
// (`--no-recaps`), the server doesn't use it, and the snapshot has no `recap` and no `recaps`.
import type { Indexer } from '../index/index.js';
import { compareSessions } from '../index/summaries.js';
import type { RecapEngine } from '../recaps/engine.js';
import type { IndexSnapshot } from '../shared/protocol.js';
import type { SnapshotView } from './snapshotLinks.js';
import { snapshotContent } from './websocket.js';

/** `snapshot` with each session decorated by the engine, groups re-sorted where Needs you changed, and `recaps`. A copy. */
export function withRecaps(snapshot: IndexSnapshot, engine: Pick<RecapEngine, 'decorate' | 'health'>): IndexSnapshot {
  return {
    ...snapshot,
    groups: snapshot.groups.map((group) => {
      let reorder = false;
      const sessions = group.sessions.map((session) => {
        const decorated = engine.decorate(session);
        if (decorated.needsYou?.reason !== session.needsYou?.reason) reorder = true;
        return decorated;
      });
      // Needs you comes first in a group (compareSessions()), and a recap can add it.
      if (reorder) sessions.sort(compareSessions);
      return { ...group, sessions };
    }),
    recaps: engine.health(),
  };
}

/**
 * The index's snapshots with recaps. Each listener has its own subscriptions to the index and the
 * engine, made when it subscribes and dropped when it unsubscribes.
 */
export function createRecapView(indexer: Pick<Indexer, 'latest' | 'subscribe'>, engine: Pick<RecapEngine, 'decorate' | 'health' | 'version' | 'subscribe'>): SnapshotView {
  let cached: { snapshot: IndexSnapshot; version: number; view: IndexSnapshot } | undefined;
  const active = new Set<() => void>();

  function viewOf(snapshot: IndexSnapshot): IndexSnapshot {
    const version = engine.version();
    if (cached !== undefined && cached.snapshot === snapshot && cached.version === version) return cached.view;
    const view = withRecaps(snapshot, engine);
    cached = { snapshot, version: engine.version(), view };
    return view;
  }

  function latest(): IndexSnapshot | undefined {
    const snapshot = indexer.latest();
    return snapshot === undefined ? undefined : viewOf(snapshot);
  }

  return {
    latest,
    subscribe(listener) {
      const current = latest();
      let told = current === undefined ? undefined : snapshotContent(current);
      const pass = (view: IndexSnapshot) => {
        told = snapshotContent(view);
        listener(view);
      };
      // Every poll, changed or not, as the index tells: the WebSocket sends a heartbeat for one that isn't.
      const offIndex = indexer.subscribe((snapshot) => pass(viewOf(snapshot)));
      // A recap landed, a call failed or the day turned: the snapshot again, only when what it carries changed.
      const offEngine = engine.subscribe(() => {
        const view = latest();
        if (view !== undefined && told !== undefined && snapshotContent(view) !== told) pass(view);
      });
      const unsubscribe = () => {
        offIndex();
        offEngine();
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
