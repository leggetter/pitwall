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
import os from 'node:os';
import path from 'node:path';
import { createGroupResolver } from '../index/grouping.js';
import { defaultConfigDir } from '../index/transcripts.js';
import { pitwallHome as defaultPitwallHome } from '../server/launch.js';
import type { UsagePlan, UsageView, UsageWindowKey } from '../shared/protocol.js';
import { DayStore } from './days.js';
import { createUsageLedger, LEDGER_KEEP_MS, type LedgerStats, type UsageLedger } from './ledger.js';
import { createRateLimitsReader, RATE_LIMITS_DIR_NAME, type RateLimits, type RateLimitsReader } from './rateLimits.js';
import { lexicalRepo } from './report.js';
import { buildUsageView, readScans, usageWindow } from './view.js';

/** The transcripts are read again at most this often; a request sooner uses the last read. */
export const REFRESH_MIN_MS = 5_000;

export interface UsageSource {
  /** The view for `window`. Never rejects: what can't be read is counted, or 'unavailable'. */
  view(window: UsageWindowKey): Promise<UsageView>;
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
  resolveRepo?: (cwd: string) => Promise<string>;
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
  const rateLimits = options.rateLimits ?? createRateLimitsReader({ dir: path.join(ownHome, RATE_LIMITS_DIR_NAME), signal: stop.signal });
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

  return {
    async view(key) {
      // Both at once: the reader's call takes about 3.5 s, and the first read of the transcripts longer.
      // The week's start needs the reset, so the transcripts are read from the earliest it could be.
      const earliest = Math.min(usageWindow(key, now(), null).since, now() - 7 * 86_400_000);
      const [limits, stats] = await Promise.all([rateLimits.read(), refresh(Math.max(earliest, now() - LEDGER_KEEP_MS))]);
      const read = readScans(ledger.scans());
      days.update(read.days.values());
      const resetsAt = limits.status === 'available' && limits.sevenDay?.resetsAt != null ? limits.sevenDay.resetsAt * 1000 : null;
      const window = usageWindow(key, now(), resetsAt);
      const malformed = ledger.scans().reduce((sum, scan) => sum + scan.malformed, 0);
      return buildUsageView(read, {
        window,
        plan: planOf(limits),
        home,
        pitwallHome: ownHome,
        resolveRepo: repoOf,
        keptDay: (day) => days.get(day),
        scan: { at: new Date(stats.at).toISOString(), files: stats.files, unreadable: stats.unreadable, malformed },
      });
    },
    isOwn: (row) => rateLimits.isOwn(row),
    close: () => stop.abort(),
  };
}
