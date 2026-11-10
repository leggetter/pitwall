// The Usage view's figures (W158): what the ledger has read (ledger.ts), for one window, with the kept
// days (days.ts) for any day whose transcripts Claude Code has since deleted. Numbers, model ids, repo
// directories and session ids only, as the usage report keeps (W131, report.ts).
//
// Each API response counts once, a sub-agent's own file first, so the copy of its calls in its
// parent's file, the older layout, isn't counted again. Cache reads and writes stay their own
// figures; rows are ranked by the stand-in cost (prices.ts), which weighs the four kinds of token
// against each other.
import { shortenHome } from '../index/grouping.js';
import {
  USAGE_ROWS_MAX,
  type UsageBucket,
  type UsageModelRow,
  type UsagePlan,
  type UsageRepoRow,
  type UsageSessionKind,
  type UsageSessionRow,
  type UsageTokens,
  type UsageView,
  type UsageWindowKey,
} from '../shared/protocol.js';
import { addModel, addTokens, dayTotal, emptyTokens, localDay, modelKey, modelRecord, showsMore, tokensOf, type DayTotals } from './days.js';
import { COST_LABEL, costOf } from './prices.js';
import { pitwallKindOf } from './report.js';
import type { CallRecord, FileScan } from './scan.js';

export interface UsageWindow {
  key: UsageWindowKey;
  since: number;
  until: number;
  from: UsageView['window']['from'];
  bucket: 'day' | 'hour';
}

export interface BuildViewOptions {
  window: UsageWindow;
  plan: UsagePlan;
  home: string;
  pitwallHome: string;
  /** The repo a working directory belongs to: its git common dir's, a worktree under its repo. */
  resolveRepo(cwd: string): Promise<string>;
  /** The kept day for a local day, YYYY-MM-DD, if there is one. */
  keptDay(day: string): DayTotals | undefined;
  scan: UsageView['scan'];
}

const HOUR = 3_600_000;

/** Local midnight at or before `ms`. */
export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The next local midnight after `dayStart`, a DST change included. */
function nextDay(dayStart: number): number {
  const d = new Date(dayStart);
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * The window for `key` at `now`: the week from the plan's reset seven days before the next one, or
 * today and the six days before it when there's no reset; the last 24 hours, from the hour; today and
 * the 13 or 29 days before it.
 */
export function usageWindow(key: UsageWindowKey, now: number, weekResetsAt: number | null): UsageWindow {
  if (key === '24h') return { key, since: Math.floor((now - 23 * HOUR) / HOUR) * HOUR, until: now, from: 'hours', bucket: 'hour' };
  if (key === 'week' && weekResetsAt !== null) {
    let since = weekResetsAt - 7 * 86_400_000;
    // A reset already past, from a read kept a while: the week after it.
    while (since + 7 * 86_400_000 <= now) since += 7 * 86_400_000;
    if (since <= now) return { key, since, until: now, from: 'reset', bucket: 'day' };
  }
  const days = key === '30d' ? 30 : key === '14d' ? 14 : 7;
  const d = new Date(startOfDay(now));
  d.setDate(d.getDate() - (days - 1));
  return { key, since: d.getTime(), until: now, from: 'days', bucket: 'day' };
}

const tokensFor = (call: CallRecord, cost: number): UsageTokens => ({
  calls: 1,
  input: call.input,
  cacheWrite: call.cacheWrite5m + call.cacheWrite1h,
  cacheRead: call.cacheRead,
  output: call.output,
  cost,
});

const byCost = (a: UsageTokens, b: UsageTokens) => b.cost - a.cost || tokensOf(b) - tokensOf(a);

function subtract(into: UsageTokens, from: UsageTokens): void {
  for (const field of ['calls', 'input', 'cacheWrite', 'cacheRead', 'output', 'cost'] as const) into[field] = Math.max(0, into[field] - from[field]);
}

function capRows<T extends UsageTokens>(rows: T[]): { rows: T[]; rest?: UsageTokens & { count: number } } {
  rows.sort(byCost);
  if (rows.length <= USAGE_ROWS_MAX) return { rows };
  const rest = { ...emptyTokens(), count: rows.length - USAGE_ROWS_MAX };
  for (const row of rows.slice(USAGE_ROWS_MAX)) addTokens(rest, row);
  return { rows: rows.slice(0, USAGE_ROWS_MAX), rest };
}

/**
 * Every local day's totals in `scans`, each response once: what the kept days are updated from, and
 * what each day's figures are measured against.
 */
export interface ReadScans {
  days: Map<string, DayTotals>;
  calls: Array<{ call: CallRecord; cost: number; subagent: boolean; scan: FileScan; parent: FileScan | undefined }>;
}

export function readScans(scans: FileScan[]): ReadScans {
  // A sub-agent's own file wins over a copy of its calls in its parent's, so it's read first.
  const ordered = [...scans].sort((a, b) => Number(b.subagent) - Number(a.subagent) || a.file.localeCompare(b.file));
  const mains = new Map<string, FileScan>();
  for (const scan of ordered) if (!scan.subagent) mains.set(scan.sessionId, scan);
  const seen = new Set<string>();
  const days = new Map<string, DayTotals>();
  const calls: ReadScans['calls'] = [];
  for (const scan of ordered) {
    const parent = scan.subagent ? mains.get(scan.sessionId) : undefined;
    for (const call of scan.calls) {
      if (seen.has(call.id)) continue;
      seen.add(call.id);
      const cost = costOf(call) ?? 0;
      const subagent = scan.subagent || call.sidechain;
      calls.push({ call, cost, subagent, scan, parent });
      const key = localDay(call.at);
      let day = days.get(key);
      if (day === undefined) days.set(key, (day = { day: key, main: emptyTokens(), subagent: emptyTokens(), models: modelRecord() }));
      const tokens = tokensFor(call, cost);
      addTokens(subagent ? day.subagent : day.main, tokens);
      addModel(day.models, call.model, tokens);
    }
  }
  return { days, calls };
}

/** The view for one window, from what readScans() read. */
export async function buildUsageView(read: ReadScans, options: BuildViewOptions): Promise<UsageView> {
  const { window } = options;
  const totals = emptyTokens();
  const buckets = new Map<number, UsageBucket>();
  const starts: number[] = [];
  if (window.bucket === 'hour') {
    for (let at = Math.floor(window.since / HOUR) * HOUR; at < window.until; at += HOUR) starts.push(at);
  } else {
    for (let at = startOfDay(window.since); at < window.until; at = nextDay(at)) starts.push(at);
  }
  for (const start of starts) buckets.set(start, { start: new Date(start).toISOString(), ...emptyTokens() });
  const bucketOf = (at: number) => buckets.get(window.bucket === 'hour' ? Math.floor(at / HOUR) * HOUR : startOfDay(at));

  const repos = new Map<string, UsageRepoRow & { members: Set<string> }>();
  const sessions = new Map<string, UsageSessionRow & { models: Map<string, number>; runs: Set<string>; hasMain: boolean }>();
  const models = new Map<string, UsageModelRow>();
  const main = { ...emptyTokens(), sessions: 0 };
  const subagent = { ...emptyTokens(), runs: 0 };
  const mainSessions = new Set<string>();
  const runs = new Set<string>();
  // What each day in the window shows from transcripts, against its kept figures.
  const windowDays = new Map<string, DayTotals>();

  const repoCache = new Map<string, Promise<string>>();
  const repoOf = (cwd: string | undefined): Promise<string> => {
    if (cwd === undefined) return Promise.resolve('(unknown directory)');
    let hit = repoCache.get(cwd);
    if (hit === undefined) {
      hit = options
        .resolveRepo(cwd)
        .then((repo) => shortenHome(repo, options.home))
        .catch(() => shortenHome(cwd, options.home));
      repoCache.set(cwd, hit);
    }
    return hit;
  };
  const labels = new Map<FileScan, Promise<{ repo: string; pitwall: boolean }>>();
  const labelOf = (scan: FileScan, parent: FileScan | undefined) => {
    let hit = labels.get(scan);
    if (hit === undefined) {
      const cwd = scan.cwd ?? parent?.cwd;
      const kind = pitwallKindOf(cwd, [...scan.names, ...(parent?.names ?? [])], options.pitwallHome);
      hit = kind === undefined ? repoOf(cwd).then((repo) => ({ repo, pitwall: false })) : Promise.resolve({ repo: `pitwall's own: ${kind}`, pitwall: true });
      labels.set(scan, hit);
    }
    return hit;
  };

  for (const { call, cost, subagent: isSub, scan, parent } of read.calls) {
    if (call.at < window.since || call.at >= window.until) continue;
    const tokens = tokensFor(call, cost);
    addTokens(totals, tokens);
    const bucket = bucketOf(call.at);
    if (bucket !== undefined) addTokens(bucket, tokens);
    const dayKey = localDay(call.at);
    let day = windowDays.get(dayKey);
    if (day === undefined) windowDays.set(dayKey, (day = { day: dayKey, main: emptyTokens(), subagent: emptyTokens(), models: modelRecord() }));
    addTokens(isSub ? day.subagent : day.main, tokens);
    addModel(day.models, call.model, tokens);

    // By model id, as the kept days key it, so a kept day's figures replace the same row.
    const id = modelKey(call.model);
    let model = models.get(id);
    if (model === undefined) models.set(id, (model = { model: id, ...emptyTokens() }));
    addTokens(model, tokens);
    if (isSub) {
      addTokens(subagent, tokens);
      runs.add(scan.subagent ? scan.file : `${scan.sessionId}:sidechain`);
    } else {
      addTokens(main, tokens);
      mainSessions.add(scan.sessionId);
    }

    const { repo, pitwall } = await labelOf(scan, parent);
    let repoRow = repos.get(repo);
    if (repoRow === undefined) repos.set(repo, (repoRow = { repo, sessions: 0, ...emptyTokens(), members: new Set() }));
    addTokens(repoRow, tokens);
    repoRow.members.add(scan.sessionId);

    let session = sessions.get(scan.sessionId);
    if (session === undefined) {
      session = { sessionId: scan.sessionId, repo, kind: 'main', model: '', subagentRuns: 0, subagentCost: 0, ...emptyTokens(), models: new Map(), runs: new Set(), hasMain: false };
      sessions.set(scan.sessionId, session);
    }
    addTokens(session, tokens);
    if (pitwall) session.kind = 'pitwall';
    if (isSub) {
      session.subagentCost += cost;
      if (scan.subagent) session.runs.add(scan.file);
    } else {
      session.hasMain = true;
      session.repo = repo;
      session.models.set(id, (session.models.get(id) ?? 0) + tokensOf(tokens));
    }
    if (!session.hasMain) session.models.set(id, (session.models.get(id) ?? 0) + tokensOf(tokens));
  }
  main.sessions = mainSessions.size;
  subagent.runs = runs.size;

  // Kept days that show more than the transcripts left: whole days inside the window only, so a
  // window that starts mid-day, as the week does, never counts a kept day's morning.
  const history = { ...emptyTokens(), days: 0 };
  if (window.bucket === 'day') {
    for (const start of starts) {
      const end = nextDay(start);
      if (start < window.since || end > window.until + 1) continue;
      const key = localDay(start);
      const kept = options.keptDay(key);
      const live = windowDays.get(key) ?? { day: key, main: emptyTokens(), subagent: emptyTokens(), models: modelRecord() };
      if (kept === undefined || !showsMore(kept, live)) continue;
      const keptTotal = dayTotal(kept);
      const liveTotal = dayTotal(live);
      const bucket = buckets.get(start);
      if (bucket !== undefined) Object.assign(bucket, keptTotal, { history: true as const });
      subtract(totals, liveTotal);
      addTokens(totals, keptTotal);
      subtract(main, live.main);
      addTokens(main, kept.main);
      subtract(subagent, live.subagent);
      addTokens(subagent, kept.subagent);
      for (const [id, figures] of Object.entries(live.models)) {
        const row = models.get(id);
        if (row !== undefined) subtract(row, figures);
      }
      for (const [id, figures] of Object.entries(kept.models)) {
        let row = models.get(id);
        if (row === undefined) models.set(id, (row = { model: id, ...emptyTokens() }));
        addTokens(row, figures);
      }
      const added = { ...keptTotal };
      subtract(added, liveTotal);
      addTokens(history, added);
      history.days++;
    }
  }

  const repoRows = [...repos.values()].map(({ members, ...row }) => ({ ...row, sessions: members.size }));
  const sessionRows = [...sessions.values()].map(({ models: used, runs: sessionRuns, hasMain, ...row }) => {
    let best = '';
    let most = -1;
    for (const [id, count] of used) if (count > most) [best, most] = [id, count];
    const kind: UsageSessionKind = row.kind === 'pitwall' ? 'pitwall' : hasMain ? 'main' : 'subagent';
    return { ...row, kind, model: best, subagentRuns: sessionRuns.size };
  });

  return {
    window: { key: window.key, since: new Date(window.since).toISOString(), until: new Date(window.until).toISOString(), from: window.from, bucket: window.bucket },
    plan: options.plan,
    costLabel: COST_LABEL,
    totals,
    buckets: starts.map((start) => buckets.get(start) as UsageBucket),
    byRepo: capRows(repoRows),
    bySession: capRows(sessionRows),
    byModel: [...models.values()].filter((row) => row.calls > 0).sort(byCost),
    split: { main, subagent },
    ...(history.days > 0 ? { history } : {}),
    scan: options.scan,
  };
}
