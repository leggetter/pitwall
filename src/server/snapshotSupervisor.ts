// The snapshot with the supervisor (M5, W113): the view under it, with `supervisor`, the
// supervisor's state (SupervisorState), added. Composed between the recaps' view and W105's:
//
//   index  ->  createRecapView()  ->  createSupervisorView()  ->  createSnapshotView()  ->  clients
//
// Like the others, it passes every snapshot on, and sends the snapshot again when the supervisor's
// state changes what it carries, never a heartbeat for one that doesn't. Without a supervisor
// (`--no-supervisor`), the server doesn't use it, and the snapshot has no `supervisor`.
import type { IndexSnapshot } from '../shared/protocol.js';
import type { Supervisor } from '../supervisor/supervisor.js';
import type { SnapshotView } from './snapshotLinks.js';
import { snapshotContent } from './websocket.js';

/** `snapshot` with the supervisor's state. A copy. */
export function withSupervisor(snapshot: IndexSnapshot, supervisor: Pick<Supervisor, 'state'>): IndexSnapshot {
  return { ...snapshot, supervisor: supervisor.state() };
}

/**
 * The snapshots of `base`, each with the supervisor's state. Each listener has its own
 * subscriptions to `base` and the supervisor, made when it subscribes and dropped when it
 * unsubscribes.
 */
export function createSupervisorView(base: Pick<SnapshotView, 'latest' | 'subscribe'>, supervisor: Pick<Supervisor, 'state' | 'version' | 'subscribe'>): SnapshotView {
  let cached: { snapshot: IndexSnapshot; version: number; view: IndexSnapshot } | undefined;
  const active = new Set<() => void>();

  function viewOf(snapshot: IndexSnapshot): IndexSnapshot {
    const version = supervisor.version();
    if (cached !== undefined && cached.snapshot === snapshot && cached.version === version) return cached.view;
    const view = withSupervisor(snapshot, supervisor);
    cached = { snapshot, version, view };
    return view;
  }

  function latest(): IndexSnapshot | undefined {
    const snapshot = base.latest();
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
      // Every snapshot, changed or not, as the view under it tells.
      const offBase = base.subscribe((snapshot) => pass(viewOf(snapshot)));
      // The supervisor started, finished a turn or stopped: the snapshot again, only when what it carries changed.
      const offSupervisor = supervisor.subscribe(() => {
        const view = latest();
        if (view !== undefined && told !== undefined && snapshotContent(view) !== told) pass(view);
      });
      const unsubscribe = () => {
        offBase();
        offSupervisor();
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
