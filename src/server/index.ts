import type { Indexer } from '../index/index.js';
import type { PrSource } from '../prs/index.js';
import type { RecapEngine } from '../recaps/engine.js';
import type { Supervisor } from '../supervisor/supervisor.js';
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
  /**
   * Per-session recaps (M5, W110): the engine the CLI makes with createRecapEngine(), so the indexer
   * can hide its calls and hand it what it read. The server starts it once it's listening, composes
   * its view of the snapshot under W105's, serves recapPath() and recapRefreshPath(), and closes it on
   * close(). Without it, recaps are off, as with `--no-recaps`: no snapshot has `recap` or `recaps`,
   * GET recapPath() answers 404, Refresh answers 409, and nothing runs a recap call, so a test never
   * reaches the model.
   */
  recaps?: RecapEngine;
  /**
   * The supervisor (M5, W113): the one the CLI makes with createSupervisor(), so the indexer can
   * hide it. The server gives it its MCP server's URL once listening, composes its state into the
   * snapshot, serves its routes and pitwall's MCP server (W112), and closes it on close(). It starts
   * only when the page asks. Without it, the supervisor is off, as with `--no-supervisor`: no
   * snapshot has `supervisor`, its routes answer 409 or 404, the MCP route 404, and nothing runs it,
   * so a test never reaches the model.
   */
  supervisor?: Supervisor;
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
