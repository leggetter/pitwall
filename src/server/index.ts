import type { Indexer } from '../index/index.js';

export interface ServerOptions {
  indexer: Indexer;
  /** Default 4517. 0 picks a free port. The host is always 127.0.0.1 and is not configurable. */
  port?: number;
  /** Per-run secret, required on API and WebSocket requests. */
  token: string;
  /** Directory of the built web UI. */
  webRoot: string;
}

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** W1 stub, replaced by W3. */
export function startServer(options: ServerOptions): Promise<RunningServer> {
  void options;
  throw new Error('not implemented: W3');
}
