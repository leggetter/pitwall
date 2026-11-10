// The Usage view's source (W158), for the server's USAGE_PATH route: the plan's week from `/usage`
// (W157, rateLimits.ts), the transcripts read on from where the last read stopped (ledger.ts), and
// each day's totals kept in pitwall's home (days.ts).
//
// Nothing here runs on a timer. The plan's percentages are read only when the view asks, through
// the reader's cache (RATE_LIMITS_TTL_MS, a failure RATE_LIMITS_FAILURE_TTL_MS), since the usage
// endpoint behind `/usage` is rate limited and shared with your own `/usage`. The transcripts are
// read only when the view asks too, and at most once every REFRESH_MIN_MS.
//
// The reader's `claude -p` call may show in `claude agents --json` while it runs, so isOwn() is the
// reader's, for the index's exclude and End session's refusal (src/cli.ts, src/server/server.ts).
//
// The run rate (W159): runRate() for the header's RUN_RATE_PATH, which a visible page asks every
// RUN_RATE_POLL_MS, through the same reader and its cache, and calls the reader at most once every
// RUN_RATE_READ_MS whether the read worked or not, so `/usage` runs for it at most once in 5 minutes
// while a page is open, and never with none. Each new reading of the week is kept
// (readings.ts) for the pace's projection (runRate.ts). report() is the one call the supervisor's
// get_usage (W160) makes: the run rate and the week's heaviest sessions. With `planReads: false`
// (`--no-usage`), no `/usage` call runs, nothing is kept, the run rate is 'off', and the view's week
// is the last 7 days.
import os from 'node:os';
import path from 'node:path';
import { createGroupResolver } from '../index/grouping.js';
import { defaultConfigDir } from '../index/transcripts.js';
import { pitwallHome as defaultPitwallHome } from '../server/launch.js';
import type { RunRate, RunRateTarget, UsagePlan, UsageSessionRow, UsageTokens, UsageView, UsageWindowKey } from '../shared/protocol.js';
import { DayStore } from './days.js';
import { createUsageLedger, LEDGER_KEEP_MS, type LedgerStats, type UsageLedger } from './ledger.js';
import { createRateLimitsReader, RATE_LIMITS_DIR_NAME, type RateLimits, type RateLimitsReader } from './rateLimits.js';
import { ReadingStore } from './readings.js';
import { DEFAULT_RUN_RATE_TARGET, levelOf, paceAt, project, type WeekReading } from './runRate.js';
import { lexicalRepo } from './report.js';
import { buildUsageView, readScans, usageWindow } from './view.js';

/** The transcripts are read again at most this often; a request sooner uses the last read. */
export const REFRESH_MIN_MS = 5_000;

/** What the supervisor's get_usage (W160) reads: the run rate, and what's using the week. */
export interface UsageReport {
  runRate: RunRate;
  week: { since: string; from: UsageView['window']['from']; totals: UsageTokens };
  /** The week's heaviest sessions by stand-in cost, at most REPORT_SESSIONS. */
  heaviest: UsageSessionRow[];
}

export const REPORT_SESSIONS = 5;

/**
 * The last kept reading stands in for a failed read this long, its age shown, before the run rate
 * says "unavailable" instead.
 */
export const FALLBACK_MAX_MS = 6 * 3_600_000;

/**
 * The run rate calls the reader at most this often, whether the last call worked or not: the reader
 * keeps a failure only 1 minute (RATE_LIMITS_FAILURE_TTL_MS), and the run rate is asked on a timer.
 */
export const RUN_RATE_READ_MS = 5 * 60_000;

export interface UsageSource {
  /** False with `--no-usage`: no `/usage` call, and the run rate is 'off'. */
  readonly planReads: boolean;
  /** The view for `window`. Never rejects: what can't be read is counted, or 'unavailable'. */
  view(window: UsageWindowKey): Promise<UsageView>;
  /** The header's run rate (W159). Never rejects. */
  runRate(): Promise<RunRate>;
  /** The run rate and the week's heaviest sessions, for the supervisor (W160). Never rejects. */
  report(): Promise<UsageReport>;
  /** True for a `claude agents` row that is the reader's own `/usage` call (RateLimitsReader.isOwn). */
  isOwn(row: { name: string; cwd: string; pid?: number | undefined; startedAt?: string | undefined }): boolean;
  /** Stops a `/usage` call in flight. */
  close(): void;
}

export interface UsageSourceOptions {
  /** pitwall's home, where the kept days go. Without one, they're kept in memory only. */
  pitwallHome?: string;
  /** Claude Code's config folder, whose `projects` holds the transcripts. */
  configDir?: string;
  home?: string;
  now?: () => number;
  /** Tests pass a fake, so none runs `claude`. */
  rateLimits?: RateLimitsReader;
  ledger?: UsageLedger;
  days?: DayStore;
  readings?: ReadingStore;
  resolveRepo?: (cwd: string) => Promise<string>;
  /** False with `--no-usage`: never reads the plan's percentages. Default true. */
  planReads?: boolean;
  /** The weekend reserve, from the config file's `runRate`; DEFAULT_RUN_RATE_TARGET without one. */
  target?: RunRateTarget;
}

/** A reader for `--no-usage`: never calls, always 'unavailable' with the reason 'off'. */
function readerOff(now: () => number): RateLimitsReader {
  const off = (): RateLimits => ({ status: 'unavailable', readAt: now(), reason: 'off' });
  return { read: async () => off(), last: () => undefined, isOwn: () => false };
}

/** The week's reading in `limits`, when it has one with a reset. */
export function weekReading(limits: RateLimits): WeekReading | undefined {
  if (limits.status !== 'available' || limits.sevenDay === null || limits.sevenDay.resetsAt === null) return undefined;
  return { at: limits.readAt, used: limits.sevenDay.usedPercentage, resetsAt: limits.sevenDay.resetsAt * 1000 };
}

/**
 * The run rate of `limits`, with `history` for the projection. When the read failed, the latest kept
 * reading of a week that hasn't reset, under FALLBACK_MAX_MS old, stands in, marked as such.
 */
export function runRateOf(limits: RateLimits, history: readonly WeekReading[], target: RunRateTarget, now: number): RunRate {
  const iso = (ms: number) => new Date(ms).toISOString();
  if (limits.status === 'unavailable') {
    if (limits.reason === 'off') return { status: 'off' };
    const last = history.at(-1);
    // Never a reading from the future: a planted one would read as fresh.
    if (last === undefined || last.at > now || now - last.at > FALLBACK_MAX_MS || now >= last.resetsAt) return { status: 'unavailable', readAt: iso(limits.readAt), reason: limits.reason };
    return {
      status: 'available',
      readAt: iso(last.at),
      fallback: { reason: limits.reason },
      target,
      sevenDay: weekOf(last, history, target),
      fiveHour: null,
    };
  }
  const reading = weekReading(limits);
  const seven = limits.sevenDay;
  const five = limits.fiveHour;
  return {
    status: 'available',
    readAt: iso(limits.readAt),
    target,
    sevenDay:
      seven === null
        ? null
        : reading === undefined
          ? { usedPercentage: seven.usedPercentage, resetsAt: null, level: levelOf(seven.usedPercentage), pace: null, projection: null }
          : weekOf(reading, history, target),
    fiveHour:
      five === null
        ? null
        : { usedPercentage: five.usedPercentage, resetsAt: five.resetsAt === null ? null : iso(five.resetsAt * 1000), level: levelOf(five.usedPercentage) },
  };
}

function weekOf(reading: WeekReading, history: readonly WeekReading[], target: RunRateTarget) {
  return {
    usedPercentage: reading.used,
    resetsAt: new Date(reading.resetsAt).toISOString(),
    level: levelOf(reading.used),
    pace: paceAt(reading.at, reading.used, reading.resetsAt, target),
    projection: project(reading, history),
  };
}

export function planOf(limits: RateLimits): UsagePlan {
  const readAt = new Date(limits.readAt).toISOString();
  if (limits.status === 'unavailable') return { status: 'unavailable', readAt, reason: limits.reason };
  const window = (each: typeof limits.sevenDay) =>
    each === null ? null : { usedPercentage: each.usedPercentage, resetsAt: each.resetsAt === null ? null : new Date(each.resetsAt * 1000).toISOString() };
  return { status: 'available', readAt, sevenDay: window(limits.sevenDay), fiveHour: window(limits.fiveHour) };
}

export function createUsageSource(options: UsageSourceOptions = {}): UsageSource {
  const now = options.now ?? Date.now;
  const home = options.home ?? os.homedir();
  const ownHome = options.pitwallHome ?? defaultPitwallHome(process.env, home);
  const stop = new AbortController();
  const planReads = options.planReads ?? true;
  const target = options.target ?? DEFAULT_RUN_RATE_TARGET;
  const rateLimits = !planReads
    ? readerOff(now)
    : (options.rateLimits ?? createRateLimitsReader({ dir: path.join(ownHome, RATE_LIMITS_DIR_NAME), signal: stop.signal }));
  // Kept only while the percentages are read: with --no-usage, the file is never opened.
  const readings = planReads ? (options.readings ?? new ReadingStore({ ...(options.pitwallHome === undefined ? {} : { home: options.pitwallHome }), now })) : undefined;
  const ledger = options.ledger ?? createUsageLedger({ projectsDir: path.join(options.configDir ?? defaultConfigDir(), 'projects'), now });
  const days = options.days ?? new DayStore({ ...(options.pitwallHome === undefined ? {} : { home: options.pitwallHome }), now });
  let resolveRepo = options.resolveRepo;
  if (resolveRepo === undefined) {
    const resolver = createGroupResolver({ ttlMs: 10 * 60_000 });
    resolveRepo = async (cwd) => {
      const key = await resolver.resolve(cwd);
      return key.kind === 'git' ? key.key : lexicalRepo(cwd);
    };
  }
  const repoOf = resolveRepo;
  let last: { at: number; since: number; stats: LedgerStats } | undefined;

  async function refresh(since: number): Promise<LedgerStats & { at: number }> {
    const at = now();
    if (last !== undefined && at - last.at < REFRESH_MIN_MS && last.since <= since) return { ...last.stats, at: last.at };
    const stats = await ledger.refresh(since);
    last = { at, since: Math.min(since, last?.since ?? since), stats };
    return { ...stats, at };
  }

  /** The plan's percentages through the reader's cache, each new reading of the week kept. */
  async function readPlan(): Promise<RateLimits> {
    const limits = await rateLimits.read();
    const reading = weekReading(limits);
    if (reading !== undefined) readings?.add(reading);
    return limits;
  }
  const runRate = (limits: RateLimits) => runRateOf(limits, readings?.all() ?? [], target, now());
  // The run rate's last call to the reader, so a failing read isn't retried every minute (RUN_RATE_READ_MS).
  let lastRunRateRead: { at: number; limits: RateLimits } | undefined;

  async function view(key: UsageWindowKey): Promise<UsageView> {
    // Both at once: the reader's call takes about 3.5 s, and the first read of the transcripts longer.
    // The week's start needs the reset, so the transcripts are read from the earliest it could be.
    const earliest = Math.min(usageWindow(key, now(), null).since, now() - 7 * 86_400_000);
    const [limits, stats] = await Promise.all([readPlan(), refresh(Math.max(earliest, now() - LEDGER_KEEP_MS))]);
    const read = readScans(ledger.scans());
    days.update(read.days.values());
    const resetsAt = limits.status === 'available' && limits.sevenDay?.resetsAt != null ? limits.sevenDay.resetsAt * 1000 : null;
    const window = usageWindow(key, now(), resetsAt);
    const malformed = ledger.scans().reduce((sum, scan) => sum + scan.malformed, 0);
    const built = await buildUsageView(read, {
      window,
      plan: planOf(limits),
      home,
      pitwallHome: ownHome,
      resolveRepo: repoOf,
      keptDay: (day) => days.get(day),
      scan: { at: new Date(stats.at).toISOString(), files: stats.files, unreadable: stats.unreadable, malformed },
    });
    return { ...built, runRate: runRate(limits) };
  }

  return {
    planReads,
    view,
    async runRate() {
      try {
        if (lastRunRateRead !== undefined && now() - lastRunRateRead.at < RUN_RATE_READ_MS) return runRate(lastRunRateRead.limits);
        const at = now();
        const limits = await readPlan();
        // A call pitwall stopped, as at shutdown, isn't an answer to keep.
        if (!(limits.status === 'unavailable' && limits.reason === 'stopped')) lastRunRateRead = { at, limits };
        return runRate(limits);
      } catch {
        return { status: 'unavailable', readAt: new Date(now()).toISOString(), reason: 'failed' };
      }
    },
    async report() {
      const week = await view('week');
      return {
        runRate: week.runRate ?? { status: 'off' },
        week: { since: week.window.since, from: week.window.from, totals: week.totals },
        heaviest: week.bySession.rows.slice(0, REPORT_SESSIONS),
      };
    },
    isOwn: (row) => rateLimits.isOwn(row),
    close: () => stop.abort(),
  };
}
