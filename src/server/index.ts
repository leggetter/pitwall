import type { Indexer } from '../index/index.js';
import { startServerWithInternals } from './server.js';

export { DEFAULT_PORT, PortInUseError } from './server.js';

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

/**
 * Serves the index on 127.0.0.1. With no port, tries 4517 and falls back to a
 * free port if it's busy; an explicit port that's busy rejects with
 * PortInUseError. `url` is `http://127.0.0.1:<port>`, the real port.
 * close() closes WebSocket clients and the HTTP server, but not the indexer.
 */
export function startServer(options: ServerOptions): Promise<RunningServer> {
  return startServerWithInternals(options);
}
