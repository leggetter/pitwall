// The usage report's aggregates (W131): totals from the transcripts' token usage, shaped to test
// the draft efficiency rules. Numbers and repo directories only, never a session's content.
//
// "Tokens" here are all four kinds Claude Code's usage records: fresh input, cache writes, cache
// reads and output. A "call" is one API response, counted once however many lines repeat it.
import os from 'node:os';
import path from 'node:path';
import { createGroupResolver, shortenHome } from '../index/grouping.js';
import { isWithin } from '../index/roots.js';
import { defaultConfigDir } from '../index/transcripts.js';
import { RECAP_NAME } from '../recaps/prompt.js';
import { pitwallHome as defaultPitwallHome } from '../server/launch.js';
import { RELAY_NAME } from '../server/relayPrompt.js';
import { SUPERVISOR_NAME } from '../supervisor/prompt.js';
import { COST_LABEL, costOf, priceKey } from './prices.js';
import { findTranscripts, scanTranscript, type CallRecord, type FileScan, type ToolResultRecord } from './scan.js';

export interface Totals {
  calls: number;
  input: number;
  cacheWrite: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  total: number;
  /** USD at API list prices; calls on a model without a price add nothing. */
  cost: number;
}

export interface Distribution {
  count: number;
  mean: number;
  median: number;
  p90: number;
  p99: number;
  max: number;
  sum: number;
}

export interface Row extends Totals {
  key: string;
  /** Distinct main sessions, or sub-agent runs where the row is about them. */
  sessions?: number;
}

export interface Bucket {
  label: string;
  calls: number;
  meanContext: number;
  meanCacheRead: number;
  cacheRead: number;
  cacheReadShare: number;
  total: number;
  totalShare: number;
}

export type PitwallKind = 'recap' | 'relay' | 'supervisor' | 'test' | 'other';

export type SessionKind = 'main' | 'subagent' | `pitwall:${PitwallKind}`;

export interface SessionSummary extends Totals {
  /** The first eight characters of the session id; never its title, which comes from a prompt. */
  session: string;
  kind: SessionKind;
  repo: string;
  model: string;
  maxContext: number;
  firstContext: number;
  subagentRuns: number;
  /** Tokens in this session's sub-agents' runs, which its own totals leave out. */
  subagentTotal: number;
}

export interface UsageReport {
  generatedAt: string;
  window: { days: number; since: string; until: string; timeZone: string };
  costLabel: string;
  files: { main: number; subagent: number; olderThanWindow: number; unreadable: number; withCalls: number };
  lines: { read: number; parsed: number; malformed: number; noTimestamp: number; outsideWindow: number; noUsage: number; synthetic: number };
  duplicates: { sameFileLines: number; crossFileCalls: number; usageDiffered: number; crossFileToolResults: number };
  caveats: { cacheWritesWithoutTtlSplit: number; unpricedModels: Record<string, number>; subagentsWithoutCwd: number };
  totals: Totals;
  byDay: Row[];
  rule1: {
    cacheReadShare: number;
    freshInputShare: number;
    cacheWriteShare: number;
    outputShare: number;
    perSession: { total: Distribution; calls: Distribution; cacheReadPerCall: Distribution; maxContext: Distribution };
    top10: SessionSummary[];
    byCallIndex: Bucket[];
    byContextSize: Bucket[];
    bySessionLength: (Row & { sessions: number })[];
  };
  rule2: { byModel: Row[]; byRepo: Row[]; byRepoModel: Row[]; byModelEffort: Row[] };
  rule3: {
    main: Totals & { sessions: number };
    subagent: Totals & { runs: number };
    runTotal: Distribution;
    runCalls: Distribution;
    runSizes: { label: string; runs: number; runShare: number; total: number; totalShare: number }[];
    byAgentType: Row[];
    firstCallContext: { main: Distribution; subagent: Distribution };
  };
  rule4: {
    activeHours: number;
    hours: { hour: string; total: number; cost: number; sessions: number; subagents: number; pitwall: number }[];
    peakHours: { hour: string; total: number; cost: number; sessions: number; subagents: number; pitwall: number }[];
    byConcurrency: { sessions: string; hours: number; total: number; totalShare: number; meanPerHour: number }[];
    busiestFiveHours: { from: string; total: number; cost: number }[];
  };
  rule5: {
    results: number;
    images: number;
    chars: Distribution;
    estimatedTokens: number;
    /** Estimated tool-result tokens against fresh input plus cache writes: how much of what enters context is tool output. */
    shareOfNewContext: number;
    /** Estimated tool-result tokens carried in every call's context, against all context sent. */
    shareOfContextSent: number;
    sizes: { label: string; results: number; chars: number; charShare: number }[];
    byTool: { tool: string; results: number; images: number; chars: number; median: number; p90: number; max: number }[];
  };
  pitwall: { byKind: Row[]; totals: Totals; shareOfTotal: number };
}

export interface ReportOptions {
  days?: number;
  now?: number;
  configDir?: string;
  home?: string;
  pitwallHome?: string;
  /** The repo a working directory belongs to; default git's common dir, a worktree under its repo. */
  resolveRepo?: (cwd: string) => Promise<string>;
}

const empty = (): Totals => ({ calls: 0, input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, total: 0, cost: 0 });

function add(totals: Totals, call: CallRecord, cost: number | undefined): void {
  const write = call.cacheWrite5m + call.cacheWrite1h;
  totals.calls++;
  totals.input += call.input;
  totals.cacheWrite += write;
  totals.cacheWrite1h += call.cacheWrite1h;
  totals.cacheRead += call.cacheRead;
  totals.output += call.output;
  totals.total += call.input + write + call.cacheRead + call.output;
  totals.cost += cost ?? 0;
}

const contextOf = (call: CallRecord) => call.input + call.cacheWrite5m + call.cacheWrite1h + call.cacheRead;
const tokensOf = (call: CallRecord) => contextOf(call) + call.output;
const share = (part: number, whole: number) => (whole > 0 ? part / whole : 0);

export function distribution(values: number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  const rank = (q: number) => (sorted.length === 0 ? 0 : (sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? 0));
  return { count: sorted.length, mean: sorted.length === 0 ? 0 : sum / sorted.length, median: rank(0.5), p90: rank(0.9), p99: rank(0.99), max: sorted.at(-1) ?? 0, sum };
}

/** Which of pitwall's own calls a session is, by its directory under pitwall's home or the name pitwall gave it. */
export function pitwallKindOf(cwd: string | undefined, names: string[], home: string): PitwallKind | undefined {
  if (cwd !== undefined && isWithin(home, path.resolve(cwd))) {
    const first = path.relative(home, path.resolve(cwd)).split(path.sep)[0];
    if (first === 'recap') return 'recap';
    if (first === 'relay' || first === 'relay-gate') return 'relay';
    if (first === 'supervisor') return 'supervisor';
    return 'other';
  }
  if (names.includes(RECAP_NAME)) return 'recap';
  if (names.includes(RELAY_NAME)) return 'relay';
  if (names.includes(SUPERVISOR_NAME)) return 'supervisor';
  if (names.some((name) => name.startsWith('pitwall-test-'))) return 'test';
  return undefined;
}

/** A worktree's path without its worktree folder, for one git can no longer resolve because it's gone. */
export function lexicalRepo(cwd: string): string {
  const match = /^(.*?)(?:\/\.worktrees\/|\/\.claude\/worktrees\/)[^/]+/.exec(cwd);
  return match?.[1] !== undefined && match[1] !== '' ? match[1] : cwd;
}

function hourOf(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00`;
}

const CALL_INDEX = [
  [1, 25],
  [26, 50],
  [51, 100],
  [101, 200],
  [201, 400],
  [401, 800],
  [801, Number.POSITIVE_INFINITY],
] as const;
const CONTEXT = [
  [0, 50_000, '<50K'],
  [50_000, 100_000, '50K-100K'],
  [100_000, 200_000, '100K-200K'],
  [200_000, 400_000, '200K-400K'],
  [400_000, 700_000, '400K-700K'],
  [700_000, Number.POSITIVE_INFINITY, '700K+'],
] as const;
const SESSION_LENGTH = [
  [1, 25],
  [26, 100],
  [101, 300],
  [301, 1000],
  [1001, Number.POSITIVE_INFINITY],
] as const;
const RUN_SIZE = [
  [0, 100_000, '<100K'],
  [100_000, 500_000, '100K-500K'],
  [500_000, 2_000_000, '500K-2M'],
  [2_000_000, 10_000_000, '2M-10M'],
  [10_000_000, Number.POSITIVE_INFINITY, '10M+'],
] as const;
const RESULT_SIZE = [
  [0, 1_000, '<1K chars'],
  [1_000, 10_000, '1K-10K'],
  [10_000, 50_000, '10K-50K'],
  [50_000, 100_000, '50K-100K'],
  [100_000, Number.POSITIVE_INFINITY, '100K+'],
] as const;

const rangeLabel = (low: number, high: number) => (high === Number.POSITIVE_INFINITY ? `${low}+` : `${low}-${high}`);

function rows(map: Map<string, Totals & { members?: Set<string> }>): Row[] {
  return [...map.entries()]
    .map(([key, totals]) => {
      const { members, ...rest } = totals;
      return members === undefined ? { key, ...rest } : { key, ...rest, sessions: members.size };
    })
    .sort((a, b) => b.total - a.total);
}

function bump(map: Map<string, Totals & { members?: Set<string> }>, key: string, call: CallRecord, cost: number | undefined, member?: string): void {
  let totals = map.get(key);
  if (totals === undefined) {
    totals = member === undefined ? empty() : { ...empty(), members: new Set<string>() };
    map.set(key, totals);
  }
  add(totals, call, cost);
  if (member !== undefined) totals.members?.add(member);
}

/** Builds the report from scanned files: the aggregation alone, without reading anything. */
export async function aggregate(
  scans: FileScan[],
  found: { olderThanWindow: number; unreadable: number },
  options: { since: number; until: number; days: number; home: string; pitwallHome: string; resolveRepo: (cwd: string) => Promise<string> },
): Promise<UsageReport> {
  // A sub-agent's own file wins over a copy of its calls in its parent's, so it's read first.
  const ordered = [...scans].sort((a, b) => Number(b.subagent) - Number(a.subagent) || a.file.localeCompare(b.file));
  const mainScans = new Map<string, FileScan>();
  for (const scan of ordered) if (!scan.subagent) mainScans.set(scan.sessionId, scan);

  const report: Omit<UsageReport, 'rule1' | 'rule2' | 'rule3' | 'rule4' | 'rule5' | 'pitwall'> = {
    generatedAt: new Date(options.until).toISOString(),
    window: { days: options.days, since: new Date(options.since).toISOString(), until: new Date(options.until).toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    costLabel: COST_LABEL,
    files: { main: 0, subagent: 0, olderThanWindow: found.olderThanWindow, unreadable: found.unreadable, withCalls: 0 },
    lines: { read: 0, parsed: 0, malformed: 0, noTimestamp: 0, outsideWindow: 0, noUsage: 0, synthetic: 0 },
    duplicates: { sameFileLines: 0, crossFileCalls: 0, usageDiffered: 0, crossFileToolResults: 0 },
    // No prototype: its keys are model ids from transcripts (W158's review).
    caveats: { cacheWritesWithoutTtlSplit: 0, unpricedModels: Object.create(null) as Record<string, number>, subagentsWithoutCwd: 0 },
    totals: empty(),
    byDay: [],
  };

  const repoCache = new Map<string, Promise<string>>();
  const repoOf = (cwd: string | undefined) => {
    if (cwd === undefined) return Promise.resolve('(unknown directory)');
    let hit = repoCache.get(cwd);
    if (hit === undefined) {
      hit = options.resolveRepo(cwd).then((repo) => shortenHome(repo, options.home));
      repoCache.set(cwd, hit);
    }
    return hit;
  };

  const seenCalls = new Set<string>();
  const seenResults = new Set<string>();
  const byDay = new Map<string, Totals>();
  const byModel = new Map<string, Totals & { members?: Set<string> }>();
  const byRepo = new Map<string, Totals & { members?: Set<string> }>();
  const byRepoModel = new Map<string, Totals & { members?: Set<string> }>();
  const byModelEffort = new Map<string, Totals & { members?: Set<string> }>();
  const byAgentType = new Map<string, Totals & { members?: Set<string> }>();
  const byPitwall = new Map<string, Totals & { members?: Set<string> }>();
  const hours = new Map<string, { total: number; cost: number; sessions: Set<string>; subagents: Set<string>; pitwall: Set<string> }>();
  const indexBuckets = CALL_INDEX.map(() => ({ calls: 0, context: 0, cacheRead: 0, total: 0 }));
  const contextBuckets = CONTEXT.map(() => ({ calls: 0, context: 0, cacheRead: 0, total: 0 }));
  const sessions = new Map<string, SessionSummary & { models: Map<string, number> }>();
  const runs: { total: number; calls: number; first: number }[] = [];
  const main = { ...empty(), sessions: 0 };
  const subagent = { ...empty(), runs: 0 };
  const pitwallTotals = empty();
  let toolContext = 0;
  let contextSent = 0;
  const results: ToolResultRecord[] = [];

  for (const scan of ordered) {
    if (scan.subagent) report.files.subagent++;
    else report.files.main++;
    if (scan.unreadable) report.files.unreadable++;
    report.lines.read += scan.lines;
    report.lines.parsed += scan.parsed;
    report.lines.malformed += scan.malformed;
    report.lines.noTimestamp += scan.noTimestamp;
    report.lines.outsideWindow += scan.outsideWindow;
    report.lines.noUsage += scan.noUsage;
    report.lines.synthetic += scan.synthetic;
    report.duplicates.sameFileLines += scan.sameFileDuplicates;
    report.duplicates.usageDiffered += scan.usageDiffered;

    const parent = scan.subagent ? mainScans.get(scan.sessionId) : undefined;
    const cwd = scan.cwd ?? parent?.cwd;
    if (scan.subagent && scan.cwd === undefined) report.caveats.subagentsWithoutCwd++;
    const kind = pitwallKindOf(cwd, [...scan.names, ...(parent?.names ?? [])], options.pitwallHome);
    const repo = kind === undefined ? await repoOf(cwd) : `(pitwall's own: ${kind})`;

    for (const result of scan.toolResults) {
      if (seenResults.has(result.id)) {
        report.duplicates.crossFileToolResults++;
        continue;
      }
      seenResults.add(result.id);
      results.push(result);
    }

    const calls = scan.calls.filter((call) => {
      if (seenCalls.has(call.id)) {
        report.duplicates.crossFileCalls++;
        return false;
      }
      seenCalls.add(call.id);
      return true;
    });
    if (calls.length === 0) continue;
    report.files.withCalls++;
    calls.sort((a, b) => a.at - b.at);

    const runKey = scan.subagent ? scan.file : `main:${scan.sessionId}`;
    let session = sessions.get(scan.sessionId);
    if (session === undefined) {
      session = {
        ...empty(),
        session: scan.sessionId.slice(0, 8),
        kind: kind === undefined ? (scan.subagent ? 'subagent' : 'main') : `pitwall:${kind}`,
        repo,
        model: '',
        maxContext: 0,
        firstContext: 0,
        subagentRuns: 0,
        subagentTotal: 0,
        models: new Map(),
      };
      sessions.set(scan.sessionId, session);
    }
    if (scan.subagent) session.subagentRuns++;
    else session.kind = kind === undefined ? 'main' : `pitwall:${kind}`;

    const run = { ...empty(), first: contextOf(calls[0] as CallRecord) };
    let index = 0;
    for (const call of calls) {
      const cost = costOf({ ...call });
      if (cost === undefined) {
        const key = priceKey(call.model);
        report.caveats.unpricedModels[key] = (report.caveats.unpricedModels[key] ?? 0) + 1;
      }
      if (!call.splitKnown) report.caveats.cacheWritesWithoutTtlSplit++;
      const isSub = scan.subagent || call.sidechain;
      add(report.totals, call, cost);
      add(isSub ? subagent : main, call, cost);
      if (isSub) session.subagentTotal += tokensOf(call);
      else {
        add(session, call, cost);
        session.models.set(call.model, (session.models.get(call.model) ?? 0) + tokensOf(call));
        session.maxContext = Math.max(session.maxContext, contextOf(call));
      }
      add(run, call, cost);

      const day = hourOf(call.at).slice(0, 10);
      let dayTotals = byDay.get(day);
      if (dayTotals === undefined) byDay.set(day, (dayTotals = empty()));
      add(dayTotals, call, cost);
      bump(byModel, call.model, call, cost, scan.sessionId);
      bump(byRepo, repo, call, cost, scan.sessionId);
      bump(byRepoModel, `${repo}  ${call.model}`, call, cost, scan.sessionId);
      bump(byModelEffort, `${call.model}  ${call.effort ?? '(not recorded)'}`, call, cost);
      if (kind !== undefined) {
        bump(byPitwall, kind, call, cost, scan.sessionId);
        add(pitwallTotals, call, cost);
      }
      if (scan.subagent) bump(byAgentType, scan.agentType ?? '(unknown)', call, cost, scan.file);

      const hour = hourOf(call.at);
      let slot = hours.get(hour);
      if (slot === undefined) hours.set(hour, (slot = { total: 0, cost: 0, sessions: new Set(), subagents: new Set(), pitwall: new Set() }));
      slot.total += tokensOf(call);
      slot.cost += cost ?? 0;
      if (kind !== undefined) slot.pitwall.add(scan.sessionId);
      else if (isSub) slot.subagents.add(runKey);
      else slot.sessions.add(scan.sessionId);

      // Rule 1 looks at the main sessions' own growth: a sub-agent's run starts afresh.
      if (!isSub && kind === undefined) {
        index++;
        const at = CALL_INDEX.findIndex(([low, high]) => index >= low && index <= high);
        const bucket = indexBuckets[at];
        if (bucket !== undefined) {
          bucket.calls++;
          bucket.context += contextOf(call);
          bucket.cacheRead += call.cacheRead;
          bucket.total += tokensOf(call);
        }
      }
      if (kind === undefined) {
        const size = contextOf(call);
        const bucket = contextBuckets[CONTEXT.findIndex(([low, high]) => size >= low && size < high)];
        if (bucket !== undefined) {
          bucket.calls++;
          bucket.context += size;
          bucket.cacheRead += call.cacheRead;
          bucket.total += tokensOf(call);
        }
      }
      toolContext += Math.min(call.toolContext, contextOf(call));
      contextSent += contextOf(call);
    }
    if (scan.subagent) {
      subagent.runs++;
      runs.push({ total: run.total, calls: run.calls, first: run.first });
    } else if (kind === undefined) {
      main.sessions++;
      session.firstContext = run.first;
    }
  }

  const sessionList = [...sessions.values()].map(({ models, ...rest }) => {
    let best = '';
    let most = -1;
    for (const [model, tokens] of models) if (tokens > most) [best, most] = [model, tokens];
    return { ...rest, model: best };
  });
  const mainSessions = sessionList.filter((each) => each.kind === 'main');
  const t = report.totals;

  report.byDay = [...byDay.entries()].map(([key, totals]) => ({ key, ...totals })).sort((a, b) => a.key.localeCompare(b.key));

  const bucketRows = (counts: { calls: number; context: number; cacheRead: number; total: number }[], labels: string[]): Bucket[] => {
    const allRead = counts.reduce((sum, each) => sum + each.cacheRead, 0);
    const allTotal = counts.reduce((sum, each) => sum + each.total, 0);
    return counts.map((each, i) => ({
      label: labels[i] ?? '',
      calls: each.calls,
      meanContext: each.calls === 0 ? 0 : Math.round(each.context / each.calls),
      meanCacheRead: each.calls === 0 ? 0 : Math.round(each.cacheRead / each.calls),
      cacheRead: each.cacheRead,
      cacheReadShare: share(each.cacheRead, allRead),
      total: each.total,
      totalShare: share(each.total, allTotal),
    }));
  };

  const lengthRows = SESSION_LENGTH.map(([low, high]) => {
    const members = mainSessions.filter((each) => each.calls >= low && each.calls <= high);
    const totals = empty();
    for (const each of members) {
      for (const field of ['calls', 'input', 'cacheWrite', 'cacheWrite1h', 'cacheRead', 'output', 'total', 'cost'] as const) totals[field] += each[field];
    }
    return { key: `${rangeLabel(low, high)} calls`, ...totals, sessions: members.length };
  });

  const rule1: UsageReport['rule1'] = {
    cacheReadShare: share(t.cacheRead, t.total),
    freshInputShare: share(t.input, t.total),
    cacheWriteShare: share(t.cacheWrite, t.total),
    outputShare: share(t.output, t.total),
    perSession: {
      total: distribution(mainSessions.map((each) => each.total)),
      calls: distribution(mainSessions.map((each) => each.calls)),
      cacheReadPerCall: distribution(mainSessions.map((each) => (each.calls === 0 ? 0 : each.cacheRead / each.calls))),
      maxContext: distribution(mainSessions.map((each) => each.maxContext)),
    },
    top10: [...sessionList].sort((a, b) => b.total - a.total).slice(0, 10),
    byCallIndex: bucketRows(
      indexBuckets,
      CALL_INDEX.map(([low, high]) => `calls ${rangeLabel(low, high)}`),
    ),
    byContextSize: bucketRows(
      contextBuckets,
      CONTEXT.map(([, , label]) => label),
    ),
    bySessionLength: lengthRows,
  };

  const rule2: UsageReport['rule2'] = { byModel: rows(byModel), byRepo: rows(byRepo), byRepoModel: rows(byRepoModel), byModelEffort: rows(byModelEffort) };

  const runTotals = runs.map((each) => each.total);
  const allRuns = runTotals.reduce((sum, each) => sum + each, 0);
  const rule3: UsageReport['rule3'] = {
    main,
    subagent,
    runTotal: distribution(runTotals),
    runCalls: distribution(runs.map((each) => each.calls)),
    runSizes: RUN_SIZE.map(([low, high, label]) => {
      const members = runTotals.filter((each) => each >= low && each < high);
      const total = members.reduce((sum, each) => sum + each, 0);
      return { label, runs: members.length, runShare: share(members.length, runs.length), total, totalShare: share(total, allRuns) };
    }),
    byAgentType: rows(byAgentType),
    firstCallContext: { main: distribution(mainSessions.map((each) => each.firstContext)), subagent: distribution(runs.map((each) => each.first)) },
  };

  const hourRows = [...hours.entries()]
    .map(([hour, slot]) => ({ hour, total: slot.total, cost: slot.cost, sessions: slot.sessions.size, subagents: slot.subagents.size, pitwall: slot.pitwall.size }))
    .sort((a, b) => a.hour.localeCompare(b.hour));
  const concurrency = ['0', '1', '2', '3', '4+'].map((label) => {
    const members = hourRows.filter((each) => (label === '4+' ? each.sessions >= 4 : each.sessions === Number(label)));
    const total = members.reduce((sum, each) => sum + each.total, 0);
    return { sessions: label, hours: members.length, total, totalShare: share(total, t.total), meanPerHour: members.length === 0 ? 0 : Math.round(total / members.length) };
  });
  const byHour = new Map(hourRows.map((each) => [each.hour, each]));
  const windows: { from: string; total: number; cost: number }[] = [];
  for (const start of hourRows) {
    const at = Date.parse(start.hour.replace(' ', 'T') + ':00');
    let total = 0;
    let cost = 0;
    for (let h = 0; h < 5; h++) {
      const slot = byHour.get(hourOf(at + h * 3_600_000));
      total += slot?.total ?? 0;
      cost += slot?.cost ?? 0;
    }
    windows.push({ from: start.hour, total, cost });
  }
  // The busiest five-hour windows that don't overlap each other.
  const busiest: { from: string; total: number; cost: number }[] = [];
  for (const each of windows.sort((a, b) => b.total - a.total)) {
    const at = Date.parse(each.from.replace(' ', 'T') + ':00');
    if (busiest.every((other) => Math.abs(Date.parse(other.from.replace(' ', 'T') + ':00') - at) >= 5 * 3_600_000)) busiest.push(each);
    if (busiest.length === 5) break;
  }
  const rule4: UsageReport['rule4'] = {
    activeHours: hourRows.length,
    hours: hourRows,
    peakHours: [...hourRows].sort((a, b) => b.total - a.total).slice(0, 10),
    byConcurrency: concurrency,
    busiestFiveHours: busiest,
  };

  const chars = results.map((each) => each.chars);
  const estimatedTokens = Math.round(chars.reduce((sum, each) => sum + each, 0) / 4);
  const totalChars = chars.reduce((sum, each) => sum + each, 0);
  const tools = new Map<string, { chars: number[]; images: number }>();
  for (const each of results) {
    const key = each.tool ?? '(not in file)';
    let tool = tools.get(key);
    if (tool === undefined) tools.set(key, (tool = { chars: [], images: 0 }));
    tool.chars.push(each.chars);
    tool.images += each.images;
  }
  const rule5: UsageReport['rule5'] = {
    results: results.length,
    images: results.reduce((sum, each) => sum + each.images, 0),
    chars: distribution(chars),
    estimatedTokens,
    shareOfNewContext: share(estimatedTokens, t.input + t.cacheWrite),
    shareOfContextSent: share(toolContext, contextSent),
    sizes: RESULT_SIZE.map(([low, high, label]) => {
      const members = chars.filter((each) => each >= low && each < high);
      const sum = members.reduce((total, each) => total + each, 0);
      return { label, results: members.length, chars: sum, charShare: share(sum, totalChars) };
    }),
    byTool: [...tools.entries()]
      .map(([tool, { chars: list, images }]) => {
        const d = distribution(list);
        return { tool, results: d.count, images, chars: d.sum, median: d.median, p90: d.p90, max: d.max };
      })
      .sort((a, b) => b.chars - a.chars)
      .slice(0, 15),
  };

  const pitwall: UsageReport['pitwall'] = { byKind: rows(byPitwall), totals: pitwallTotals, shareOfTotal: share(pitwallTotals.total, t.total) };
  return { ...report, rule1, rule2, rule3, rule4, rule5, pitwall };
}

/** Reads the last `days` days of transcripts and builds the report. Read-only. */
export async function buildUsageReport(options: ReportOptions = {}): Promise<UsageReport> {
  const days = options.days ?? 14;
  const until = options.now ?? Date.now();
  const since = until - days * 86_400_000;
  const home = options.home ?? os.homedir();
  const projectsDir = path.join(options.configDir ?? defaultConfigDir(), 'projects');
  const found = await findTranscripts(projectsDir, since);
  const scans: FileScan[] = [];
  // A few files at a time: they're streamed, so memory stays flat, and the order of the results
  // doesn't matter, since aggregate() sorts them.
  const queue = [...found.files];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) scans.push(await scanTranscript(next, since, until));
    }),
  );
  let resolveRepo = options.resolveRepo;
  if (resolveRepo === undefined) {
    const resolver = createGroupResolver({ ttlMs: Number.POSITIVE_INFINITY });
    resolveRepo = async (cwd) => {
      const key = await resolver.resolve(cwd);
      return key.kind === 'git' ? key.key : lexicalRepo(cwd);
    };
  }
  return aggregate(scans, found, { since, until, days, home, pitwallHome: options.pitwallHome ?? defaultPitwallHome(process.env, home), resolveRepo });
}
