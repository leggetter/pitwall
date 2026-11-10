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
// RATE_LIMITS_TTL_MS and runs at most one call at a time.
import os from 'node:os';
import { isRecord } from '../index/guards.js';
import { runRecapCall, spawnRecapChild, type RecapSpawner } from '../recaps/call.js';
import { relayEnvironment } from '../server/relay.js';

/** One window of the plan's limit. */
export interface RateWindow {
  /** Share of the window used, 0 to 100 as the server reports it. */
  usedPercentage: number;
  /** When the window resets, in Unix seconds rounded to the minute; null when the server gave none. */
  resetsAt: number | null;
}

/** Why the percentages couldn't be read. */
export type RateLimitsUnavailable =
  /** `claude` wasn't found. */
  | 'not-found'
  /** The call didn't start, exited non-zero, was too large or was stopped. */
  | 'failed'
  | 'timeout'
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

function readWindow(row: Record<string, unknown>): RateWindow | undefined {
  const percent = row.percent;
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0) return undefined;
  const resets = row.resets_at;
  let resetsAt: number | null = null;
  if (typeof resets === 'string') {
    const ms = Date.parse(resets);
    if (!Number.isFinite(ms)) return undefined;
    resetsAt = toMinute(ms);
  } else if (resets !== null && resets !== undefined) {
    return undefined;
  }
  return { usedPercentage: percent, resetsAt };
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
  /** Where the call runs; it reads nothing there. The OS's temporary folder unless given. */
  cwd?: string;
  /** pitwall's environment; the relay's rules apply (relayEnvironment()). */
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

/** Runs `/usage` once. Never rejects. */
export async function readRateLimits(options: ReadRateLimitsOptions = {}): Promise<RateLimits> {
  const now = options.now ?? Date.now;
  const outcome = await runRecapCall({
    claudeBin: options.claudeBin ?? 'claude',
    args: rateLimitsArgs(),
    cwd: options.cwd ?? os.tmpdir(),
    env: relayEnvironment(options.env ?? process.env),
    input: RATE_LIMITS_INPUT,
    timeoutMs: options.timeoutMs ?? RATE_LIMITS_TIMEOUT_MS,
    spawn: options.spawn ?? spawnRecapChild,
    onPid: options.onPid ?? (() => undefined),
    signal: options.signal ?? new AbortController().signal,
  });
  const readAt = now();
  switch (outcome.kind) {
    case 'exit':
      if (outcome.code !== 0) return { status: 'unavailable', readAt, reason: 'failed' };
      return parseRateLimits(outcome.stdout, readAt);
    case 'spawn-error':
      return { status: 'unavailable', readAt, reason: outcome.notFound ? 'not-found' : 'failed' };
    case 'timeout':
      return { status: 'unavailable', readAt, reason: 'timeout' };
    default:
      return { status: 'unavailable', readAt, reason: 'failed' };
  }
}

/** How long a read is kept: the usage endpoint is rate limited, and your own `/usage` shares it. */
export const RATE_LIMITS_TTL_MS = 5 * 60_000;

export interface RateLimitsReader {
  /** The last read if it's younger than the TTL, otherwise a new one; callers at once share one call. */
  read(): Promise<RateLimits>;
  /** The last read, without a call; undefined before the first. */
  last(): RateLimits | undefined;
}

export function createRateLimitsReader(options: ReadRateLimitsOptions & { ttlMs?: number } = {}): RateLimitsReader {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? RATE_LIMITS_TTL_MS;
  let cached: RateLimits | undefined;
  let pending: Promise<RateLimits> | undefined;
  return {
    read() {
      if (cached !== undefined && now() - cached.readAt < ttlMs) return Promise.resolve(cached);
      pending ??= readRateLimits(options).then((result) => {
        cached = result;
        pending = undefined;
        return result;
      });
      return pending;
    },
    last: () => cached,
  };
}
