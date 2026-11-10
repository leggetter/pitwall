// The plan's own percentages, the five-hour and weekly windows, read from Claude Code's `/usage`
// report (W157, spike 013, docs/spikes/013-rate-limits.md). W158 (the Usage view) uses the week's
// reset; W159 (the run rate) uses both windows' percentages.
//
// `/usage` sent to `claude -p` with `--output-format stream-json` answers with one assistant message
// that carries `usage_report`, the Agent SDK's documented, experimental `SDKUsageReport`. Claude Code
// answers it itself: no model call, no tokens (spike 013: cost 0, model `<synthetic>`, about 3.5 s).
// The type is experimental and the rows are the server's, so this is the one module that reads them,
// and every way it can fail comes back as `unavailable`, never a throw (AGENTS.md).
//
// Only `usage_report.rate_limits.limits` is read. The message's text, the session block and every
// other field are dropped unread, so nothing else from the account reaches pitwall.
//
// The usage endpoint behind `/usage` is rate limited and shared with your own `/usage` (the costs
// docs' "When the usage request fails"), so createRateLimitsReader() keeps a read for
// RATE_LIMITS_TTL_MS, a failure for RATE_LIMITS_FAILURE_TTL_MS, and runs one call at a time.
//
// The call runs from one fixed 0700 directory, `$PITWALL_HOME/rate-limits`. While it runs, Claude
// Code may list it in `claude agents --json`, as it does a recap call (spike 010, finding 1), so the
// reader's isOwn() leaves it out of the index as the recap engine's does: by its pid while it runs,
// by its directory, and by its name when the row started under OWN_NAME_MS ago. The first caller
// (W158) wires it into the index's exclude and the server's isRelay.
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { isRecord } from '../index/guards.js';
import { runRecapCall, spawnRecapChild, type CallOutcome, type RecapSpawner } from '../recaps/call.js';
import { OWN_NAME_MS } from '../recaps/engine.js';
import { recapEnvironment } from '../recaps/prompt.js';
import { pitwallHome } from '../server/launch.js';
import { prepareRelayDir } from '../server/relay.js';

/** One window of the plan's limit. */
export interface RateWindow {
  /**
   * Share of the window used, as the server reports it: 0 to 100 (spike 013), not a 0-to-1 fraction
   * as `rate_limit_event`'s undocumented `utilization` is. Over 100 is kept, in case a window can be
   * overrun; anything outside 0 to 1000 is taken as unreadable.
   */
  usedPercentage: number;
  /** When the window resets, in Unix seconds rounded to the minute; null when the server gave none. */
  resetsAt: number | null;
}

/** Why the percentages couldn't be read. */
export type RateLimitsUnavailable =
  /** `claude` wasn't found. */
  | 'not-found'
  /** The call didn't start, exited non-zero, or printed too much. */
  | 'failed'
  | 'timeout'
  /** pitwall stopped it, as when it's closing. Never cached. */
  | 'stopped'
  /**
   * No `usage_report` came back: not a claude.ai login (an API key, Bedrock, Vertex), a
   * `claude setup-token` token, usage-based billing, or a Claude Code too old to send it.
   */
  | 'no-report'
  /** The report came, but its `rate_limits` was null, or not as documented. */
  | 'no-limits';

export type RateLimits =
  | {
      status: 'available';
      /** When pitwall read it, Unix milliseconds. */
      readAt: number;
      /** The five-hour window, the server's `session` row; null when the server sent none. */
      fiveHour: RateWindow | null;
      /** The week, the server's `weekly_all` row; null when the server sent none. */
      sevenDay: RateWindow | null;
    }
  | { status: 'unavailable'; readAt: number; reason: RateLimitsUnavailable };

/** The server's row kinds, from SDKUsageReport's docs. Scoped rows (one model's week) are left out. */
const FIVE_HOUR_KIND = 'session';
const SEVEN_DAY_KIND = 'weekly_all';

export const RATE_LIMITS_NAME = 'pitwall-usage';
/** As the recap call's: no cross-session messages in, no auto memory. */
const RATE_LIMITS_SETTINGS = JSON.stringify({ crossSessionInbound: 'refuse', autoMemoryEnabled: false });

/**
 * The command line after `claude`. `/usage` itself goes over stdin. The rest is the recap call's
 * isolation: no transcript, no tools, none of your settings, hooks, plugins or MCP servers.
 * `--model haiku` and `--max-turns 1` only bound the cost should a later Claude Code ever pass
 * `/usage` to the model; spike 013 measured none.
 */
export function rateLimitsArgs(): string[] {
  return [
    '-p',
    '--no-session-persistence',
    '--model',
    'haiku',
    '--max-turns',
    '1',
    '--output-format',
    'stream-json',
    // Claude Code requires --verbose for stream-json output with -p.
    '--verbose',
    '--tools',
    '',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--settings',
    RATE_LIMITS_SETTINGS,
    '--name',
    RATE_LIMITS_NAME,
  ];
}

export const RATE_LIMITS_INPUT = '/usage';

/** Seconds to the nearest minute: the server's reset times jitter by under a second between reads. */
function toMinute(ms: number): number {
  return Math.round(ms / 60_000) * 60;
}

/** The most a percentage may be before it's taken as unreadable. */
const MAX_PERCENT = 1000;

/** A row's window; undefined when its percentage is unreadable. A reset that is missing or unreadable is null. */
function readWindow(row: Record<string, unknown>): RateWindow | undefined {
  const percent = row.percent;
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > MAX_PERCENT) return undefined;
  const resets = row.resets_at;
  const ms = typeof resets === 'string' ? Date.parse(resets) : NaN;
  return { usedPercentage: percent, resetsAt: Number.isFinite(ms) ? toMinute(ms) : null };
}

/**
 * Reads `claude -p --output-format stream-json`'s output for `/usage`. Never throws. A row that
 * isn't as documented leaves its window null; the first row of each kind counts.
 */
export function parseRateLimits(stdout: string, readAt: number): RateLimits {
  let report: Record<string, unknown> | undefined;
  for (const line of stdout.split('\n')) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    let event: unknown;
    try {
      event = JSON.parse(text);
    } catch {
      continue;
    }
    if (isRecord(event) && event.type === 'assistant' && isRecord(event.usage_report)) {
      report = event.usage_report;
      break;
    }
  }
  if (report === undefined) return { status: 'unavailable', readAt, reason: 'no-report' };
  const limits = isRecord(report.rate_limits) ? report.rate_limits.limits : undefined;
  if (!Array.isArray(limits)) return { status: 'unavailable', readAt, reason: 'no-limits' };
  let fiveHour: RateWindow | null = null;
  let sevenDay: RateWindow | null = null;
  let seenFive = false;
  let seenSeven = false;
  for (const row of limits) {
    if (!isRecord(row)) continue;
    if (row.kind === FIVE_HOUR_KIND && !seenFive) {
      seenFive = true;
      fiveHour = readWindow(row) ?? null;
    } else if (row.kind === SEVEN_DAY_KIND && !seenSeven) {
      seenSeven = true;
      sevenDay = readWindow(row) ?? null;
    }
  }
  return { status: 'available', readAt, fiveHour, sevenDay };
}

export interface ReadRateLimitsOptions {
  claudeBin?: string;
  /** pitwall's environment; the recap call's rules apply (recapEnvironment()). */
  env?: NodeJS.ProcessEnv;
  /** Tests pass a fake, so no test runs `claude` (src/test/noClaude.ts). */
  spawn?: RecapSpawner;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called with the call's pid, so the index can leave it out, as it does recap calls. */
  onPid?(pid: number): void;
  now?(): number;
}

/** About 3.5 s in spike 013; the rest is slack for a slow network. */
export const RATE_LIMITS_TIMEOUT_MS = 30_000;

/**
 * Runs `/usage` once, from `cwd`, which it reads nothing from. Never rejects. The environment is the
 * recap call's: no code-loading variables, no effort variables, output capped, so the call stays
 * bounded should `/usage` ever reach the model.
 */
export async function readRateLimits(cwd: string, options: ReadRateLimitsOptions = {}): Promise<RateLimits> {
  const now = options.now ?? Date.now;
  let outcome: CallOutcome;
  try {
    outcome = await callUsage(cwd, options);
  } catch {
    outcome = { kind: 'spawn-error', notFound: false };
  }
  return readOutcome(outcome, now());
}

function callUsage(cwd: string, options: ReadRateLimitsOptions): Promise<CallOutcome> {
  return runRecapCall({
    claudeBin: options.claudeBin ?? 'claude',
    args: rateLimitsArgs(),
    cwd,
    env: recapEnvironment(options.env ?? process.env),
    input: RATE_LIMITS_INPUT,
    timeoutMs: options.timeoutMs ?? RATE_LIMITS_TIMEOUT_MS,
    spawn: options.spawn ?? spawnRecapChild,
    onPid: options.onPid ?? (() => undefined),
    signal: options.signal ?? new AbortController().signal,
  });
}

function readOutcome(outcome: CallOutcome, readAt: number): RateLimits {
  switch (outcome.kind) {
    case 'exit':
      if (outcome.code !== 0) return { status: 'unavailable', readAt, reason: 'failed' };
      return parseRateLimits(outcome.stdout, readAt);
    case 'spawn-error':
      return { status: 'unavailable', readAt, reason: outcome.notFound ? 'not-found' : 'failed' };
    case 'timeout':
      return { status: 'unavailable', readAt, reason: 'timeout' };
    case 'stopped':
      return { status: 'unavailable', readAt, reason: 'stopped' };
    case 'too-large':
      return { status: 'unavailable', readAt, reason: 'failed' };
  }
}

/** How long a read is kept: the usage endpoint is rate limited, and your own `/usage` shares it. */
export const RATE_LIMITS_TTL_MS = 5 * 60_000;
/** How long a failed or timed-out read is kept, so a passing failure clears sooner. */
export const RATE_LIMITS_FAILURE_TTL_MS = 60_000;
/** The call's directory under `$PITWALL_HOME`. */
export const RATE_LIMITS_DIR_NAME = 'rate-limits';

export interface RateLimitsReader {
  /** The last read if it's still kept, otherwise a new one; callers at once share one call. Never rejects. */
  read(): Promise<RateLimits>;
  /** The last read, without a call; undefined before the first. */
  last(): RateLimits | undefined;
  /**
   * True for a `claude agents` row that is this reader's call: by its pid while it runs, by its
   * directory, or by its name when the row started under OWN_NAME_MS ago. For the index's `exclude`
   * and the server's isRelay, as the recap engine's isOwn().
   */
  isOwn(row: { name: string; cwd: string; pid?: number | undefined; startedAt?: string | undefined }): boolean;
}

export interface RateLimitsReaderOptions extends Omit<ReadRateLimitsOptions, 'onPid'> {
  /** The call's directory, `$PITWALL_HOME/rate-limits` unless given; made 0700 before the first call. */
  dir?: string;
  /** Makes `dir` and returns its real path; prepareRelayDir() unless given. */
  prepareDir?(dir: string): string;
  ttlMs?: number;
  failureTtlMs?: number;
}

export function createRateLimitsReader(options: RateLimitsReaderOptions = {}): RateLimitsReader {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? RATE_LIMITS_TTL_MS;
  const failureTtlMs = options.failureTtlMs ?? RATE_LIMITS_FAILURE_TTL_MS;
  const dir = path.resolve(options.dir ?? path.join(pitwallHome(options.env ?? process.env), RATE_LIMITS_DIR_NAME));
  const prepareDir = options.prepareDir ?? prepareRelayDir;
  const dirs = new Set<string>([dir]);
  try {
    dirs.add(realpathSync(dir));
  } catch {
    // Not made yet: prepareDir() adds its real path on the first read.
  }
  const pids = new Set<number>();
  let cached: RateLimits | undefined;
  let pending: Promise<RateLimits> | undefined;

  function kept(result: RateLimits): boolean {
    if (result.status === 'available') return now() - result.readAt < ttlMs;
    if (result.reason === 'stopped') return false;
    return now() - result.readAt < failureTtlMs;
  }
  async function readOnce(): Promise<RateLimits> {
    let cwd: string;
    try {
      cwd = prepareDir(dir);
      dirs.add(cwd);
    } catch {
      return { status: 'unavailable', readAt: now(), reason: 'failed' };
    }
    let pid: number | undefined;
    try {
      return await readRateLimits(cwd, {
        ...options,
        onPid(given) {
          pid = given;
          pids.add(given);
        },
      });
    } finally {
      if (pid !== undefined) pids.delete(pid);
    }
  }
  return {
    read() {
      if (cached !== undefined && kept(cached)) return Promise.resolve(cached);
      pending ??= readOnce().then((result) => {
        pending = undefined;
        if (result.status === 'unavailable' && result.reason === 'stopped') return result;
        cached = result;
        return result;
      });
      return pending;
    },
    last: () => cached,
    isOwn(row) {
      if (row.pid !== undefined && pids.has(row.pid)) return true;
      if (dirs.has(path.resolve(row.cwd))) return true;
      if (row.name !== RATE_LIMITS_NAME) return false;
      const started = row.startedAt === undefined ? NaN : Date.parse(row.startedAt);
      return Number.isFinite(started) && now() - started < OWN_NAME_MS;
    },
  };
}
