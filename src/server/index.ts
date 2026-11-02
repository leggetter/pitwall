import type { Indexer } from '../index/index.js';
import type { PrSource } from '../prs/index.js';
import type { RelayManager } from './relay.js';
import { startServerWithInternals } from './server.js';

export { DEFAULT_PORT, PortInUseError } from './server.js';
export { createRelayManager, type RelayManager } from './relay.js';

export interface ServerOptions {
  indexer: Indexer;
  /** Default 4517. 0 picks a free port. The host is always 127.0.0.1 and is not configurable. */
  port?: number;
  /** Per-run secret, required on API and WebSocket requests. */
  token: string;
  /** Directory of the built web UI. */
  webRoot: string;
  /**
   * The relay for messaging interactive sessions (W11, D8). The CLI makes it,
   * so the indexer can hide the relay's own session. Default: a new one. The
   * server stops it on close().
   */
  relay?: RelayManager;
  /**
   * Called each time a WebSocket client, on WS_PATH or ATTACH_PATH, answers
   * its challenge with a valid proof. The CLI deletes a per-run token's launch
   * file at the first. A hook that throws is ignored.
   */
  onAuthenticated?: () => void;
  /**
   * pitwall's own folder, `$PITWALL_HOME` or `~/.pitwall`, which the CLI
   * passes (pitwallHome()). Uploads for New session's first prompt (W79) are
   * kept in its `attachments` folder, which is swept at startup and every 10
   * minutes. Without it, ATTACHMENTS_PATH answers 503, spawn knows no
   * attachment ids, and nothing on disk is touched, so a test never reaches
   * the real ~/.pitwall.
   */
  pitwallHome?: string;
  /**
   * Your open pull requests (M4): the poller the CLI makes with createPrPoller(), which the
   * server starts once it's listening and stops on close(). Without it, pull requests are off, as
   * with `--no-prs`: GET PRS_PATH answers the 'off' list, Refresh answers 409, and nothing runs
   * gh, so a test never reaches GitHub.
   */
  prs?: PrSource;
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
