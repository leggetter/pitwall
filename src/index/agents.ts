// The session source: `claude agents --json --all`, a documented interface (D1).
// `--all` adds background sessions that have finished or been stopped, which
// plain `--json` leaves out once their process has gone (M2, W12 finding).

import os from 'node:os';
import path from 'node:path';
import type { BackgroundState, ProcessStatus, SessionKind, WaitingFor } from '../shared/protocol.js';
import { oneLine, RunError, runFile, type RunFile } from './exec.js';
import { isNonEmptyString, isRecord } from './guards.js';

/** One validated row of `claude agents --json --all`. */
export interface AgentRow {
  sessionId: string;
  /** `id` in the JSON. Background sessions only. */
  shortId?: string;
  name: string;
  kind: SessionKind;
  /** As reported, which is the directory Claude Code encodes for the transcript path. */
  cwd: string;
  pid?: number;
  status?: ProcessStatus;
  state?: BackgroundState;
  waitingFor?: WaitingFor;
  /** ISO 8601. */
  startedAt: string;
}

export type AgentsResult =
  | {
      ok: true;
      rows: AgentRow[];
      /**
       * The `sessionId` of every row with a string one, those parseAgentRows() skipped included: a row
       * with an unknown `kind`, no `startedAt` or a relative `cwd` is still a session Claude Code lists,
       * so it isn't one that has ended (W73, W81). createAgentsSource() always sets it. Read it with
       * listedSessionIds(), which adds `rows`' ids, for a source that leaves it out, as tests' fakes do.
       */
      sessionIds?: string[];
    }
  | { ok: false; error: string };

export interface AgentsSourceOptions {
  /** Default 'claude'. */
  claudeBin?: string;
  run?: RunFile;
  /**
   * Directory to run the command from. Default `os.tmpdir()`.
   *
   * `claude agents --json` works from a directory the user hasn't trusted
   * (checked on Claude Code 2.1.301 from a fresh `mktemp -d`: exit 0, the full
   * list, nothing printed on stderr, nothing written to the directory; checked
   * again with `--all` on 2.1.302). The temp directory is used so the result
   * never depends on where pitwall was started, or on project settings in that
   * directory.
   */
  cwd?: string;
  /** Default 10000. */
  timeoutMs?: number;
}

export interface AgentsSource {
  /** Never rejects. */
  list(): Promise<AgentsResult>;
}

const ARGS = ['agents', '--json', '--all'] as const;
const COMMAND = `claude ${ARGS.join(' ')}`;

export function createAgentsSource(options: AgentsSourceOptions = {}): AgentsSource {
  const given = options.claudeBin ?? 'claude';
  // A relative path like `./bin/claude` means relative to where pitwall was
  // started, not to the directory the command runs from. A bare name is
  // looked up on PATH.
  const claudeBin = given.includes('/') || given.includes(path.sep) ? path.resolve(given) : given;
  const run = options.run ?? runFile;
  const cwd = options.cwd ?? os.tmpdir();
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    async list() {
      let stdout: string;
      try {
        stdout = await run(claudeBin, ARGS, { cwd, timeoutMs });
      } catch (err) {
        return { ok: false, error: describeRunFailure(err, claudeBin) };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        return { ok: false, error: `${COMMAND} printed output that isn't JSON` };
      }
      if (!Array.isArray(parsed)) {
        return { ok: false, error: `${COMMAND} didn't print a JSON array` };
      }
      return { ok: true, rows: parseAgentRows(parsed), sessionIds: rawSessionIds(parsed) };
    },
  };
}

/**
 * Every session id a listing names, in any row: its `sessionIds` and its rows' ids. A session in it
 * is running or listed, whatever its row looked like, so it hasn't ended. The index decides what's
 * ended with it, and the resume route checks a fresh listing with it.
 */
export function listedSessionIds(result: Extract<AgentsResult, { ok: true }>): Set<string> {
  const ids = new Set(result.sessionIds);
  for (const row of result.rows) ids.add(row.sessionId);
  return ids;
}

/** The `sessionId` of every row that is an object with a string one, valid row or not. */
function rawSessionIds(input: readonly unknown[]): string[] {
  const ids = new Set<string>();
  for (const item of input) if (isRecord(item) && typeof item.sessionId === 'string') ids.add(item.sessionId);
  return [...ids];
}

function describeRunFailure(err: unknown, claudeBin: string): string {
  if (err instanceof RunError) {
    if (err.reason === 'not-found') return `${COMMAND} failed: ${claudeBin} was not found`;
    return `${COMMAND} ${err.message}`;
  }
  return `${COMMAND} failed: ${oneLine(err instanceof Error ? err.message : String(err))}`;
}

const KINDS: readonly SessionKind[] = ['interactive', 'background'];
const STATUSES: readonly ProcessStatus[] = ['busy', 'waiting', 'idle'];
const STATES: readonly BackgroundState[] = ['working', 'blocked', 'done', 'failed', 'stopped'];

/**
 * Validates rows, skipping any that are malformed and ignoring unknown fields.
 * A row needs a `sessionId`, an absolute `cwd`, a known `kind` and a readable
 * `startedAt` (epoch milliseconds, as Claude Code 2.1.301 and 2.1.302 print it
 * for every row, finished ones from `--all` included, or an ISO string).
 * Unknown `status` and `state` values are dropped, because the contract's
 * unions are closed; any `waitingFor` string passes through.
 * A repeated `sessionId` keeps the first row, or the first one with a process.
 */
export function parseAgentRows(input: readonly unknown[]): AgentRow[] {
  const byId = new Map<string, AgentRow>();
  for (const item of input) {
    const row = parseAgentRow(item);
    if (!row) continue;
    const existing = byId.get(row.sessionId);
    if (!existing || (existing.pid === undefined && row.pid !== undefined)) byId.set(row.sessionId, row);
  }
  return [...byId.values()];
}

function parseAgentRow(item: unknown): AgentRow | undefined {
  if (!isRecord(item)) return undefined;
  const { sessionId, cwd, kind } = item;
  if (!isNonEmptyString(sessionId)) return undefined;
  if (!isNonEmptyString(cwd) || !path.isAbsolute(cwd)) return undefined;
  if (!includes(KINDS, kind)) return undefined;
  const startedAt = parseTime(item.startedAt);
  if (startedAt === undefined) return undefined;

  const shortId = isNonEmptyString(item.id) ? item.id : undefined;
  const row: AgentRow = {
    sessionId,
    name: isNonEmptyString(item.name) ? item.name : (shortId ?? sessionId.slice(0, 8)),
    kind,
    cwd,
    startedAt,
  };
  if (shortId !== undefined) row.shortId = shortId;
  if (typeof item.pid === 'number' && Number.isInteger(item.pid) && item.pid > 0) row.pid = item.pid;
  if (includes(STATUSES, item.status)) row.status = item.status;
  if (includes(STATES, item.state)) row.state = item.state;
  if (isNonEmptyString(item.waitingFor)) row.waitingFor = item.waitingFor;
  return row;
}

function parseTime(value: unknown): string | undefined {
  let ms: number;
  if (typeof value === 'number') ms = value;
  else if (typeof value === 'string' && value.trim() !== '') ms = Date.parse(value);
  else return undefined;
  if (!Number.isFinite(ms)) return undefined;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}
