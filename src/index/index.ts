import type { IndexSnapshot } from '../shared/protocol.js';

export interface IndexerOptions {
  /** Absolute paths. The indexer resolves them with realpath. */
  roots: string[];
  /** Poll interval in milliseconds. Default 2000. */
  intervalMs?: number;
  /** Path or name of the claude binary. Default 'claude'. */
  claudeBin?: string;
}

export interface Indexer {
  /** The latest snapshot, or undefined before the first poll completes. */
  latest(): IndexSnapshot | undefined;
  /** Called with every new snapshot. Returns an unsubscribe function. */
  subscribe(listener: (snapshot: IndexSnapshot) => void): () => void;
  stop(): void;
}

/**
 * W1 stub, replaced by W2. Emits one empty snapshot on the next tick, so a
 * listener subscribed straight after this call receives it, then does nothing
 * until stop(). The roots are used as given, without realpath.
 */
export function startIndexer(options: IndexerOptions): Indexer {
  const listeners = new Set<(snapshot: IndexSnapshot) => void>();
  let latest: IndexSnapshot | undefined;

  const first = setTimeout(() => {
    latest = {
      generatedAt: new Date().toISOString(),
      roots: [...options.roots],
      groups: [],
      source: { ok: true },
    };
    for (const listener of [...listeners]) listener(latest);
  }, 0);

  return {
    latest: () => latest,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stop() {
      clearTimeout(first);
      listeners.clear();
    },
  };
}
