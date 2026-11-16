// The diagnostics report's numbers (W165), for scripts/diagnostics-report.ts: from the log's lines,
// how long each session stayed in Needs you and for which reason, which reasons fire most, and what
// the PR poller found. Pure, so it's tested without a log. Ids and fixed words in, the same out.
import type { DiagnosticsLine, PollLine, SessionStateLine } from './diagnostics.js';

/** A stretch of one session in Needs you for one reason. */
export interface Segment {
  sessionId: string;
  from: string;
  /** Absent while it is still in. */
  to?: string;
  /** Milliseconds, to `to` or to the report's `now` while it's open. */
  ms: number;
  /** `recap`, `asked` and so on for the session's own reason; `pr:review-requested` and so on when only a PR put it there. */
  reason: string;
  /** The PR behind it, when one did. */
  prRef?: string;
  setAside?: string;
  over?: string;
  atStart?: boolean;
}

export interface DiagnosticsReport {
  days: number;
  lines: number;
  sessions: number;
  enters: number;
  /** Stretches that began in the window, by reason, most first. */
  byReason: Record<string, { stretches: number; totalMs: number; longestMs: number }>;
  /** Stretches by which one the row explained when both held. */
  byWon: Record<string, number>;
  /** Stretches in progress at the end of the log. */
  open: number;
  /** Every stretch, oldest first (or the chosen session's, when `session` is given). */
  segments: Segment[];
  polls: {
    logged: number;
    failedSearches: number;
    skippedTotal: number;
    /** The latest poll's counts. */
    latest?: PollLine['searches'];
    /** Per search: polls logged, how many failed, and PRs skipped as reviewed already. */
    byRelation: Record<string, { polls: number; failed: number; skipped: number }>;
  };
  /** With `session`: its lines, oldest first. */
  timeline?: SessionStateLine[];
}

export interface ReportOptions {
  days: number;
  now: number;
  /** A full session id, or a prefix of at least 8 characters. */
  session?: string;
}

/** The label of the reason a line is in Needs you for. */
export function reasonLabel(line: Pick<SessionStateLine, 'own' | 'prNeed'>): string {
  if (line.own !== undefined) return line.own;
  if (line.prNeed !== undefined) return `pr:${line.prNeed}`;
  return 'unknown';
}

const sortBy = <T>(entries: [string, T][], weight: (value: T) => number): Record<string, T> =>
  Object.fromEntries(entries.sort((a, b) => weight(b[1]) - weight(a[1])));

export function buildReport(all: readonly DiagnosticsLine[], { days, now, session }: ReportOptions): DiagnosticsReport {
  const since = now - days * 24 * 60 * 60 * 1000;
  const lines = all.filter((line) => Date.parse(line.at) >= since);
  const states = lines.filter((line): line is SessionStateLine => line.kind !== 'poll');
  const matches = (id: string) => session === undefined || (session.length >= 8 && id.startsWith(session)) || id === session;
  const chosen = states.filter((line) => matches(line.sessionId));

  // A stretch opens on an enter or a change, and ends on the next line for that session.
  const segments: Segment[] = [];
  const openOf = new Map<string, Segment>();
  for (const line of chosen) {
    const open = openOf.get(line.sessionId);
    if (open !== undefined) {
      open.to = line.at;
      open.ms = Math.max(0, Date.parse(line.at) - Date.parse(open.from));
      if (line.kind === 'leave') {
        if (line.setAside !== undefined) open.setAside = line.setAside;
        if (line.over !== undefined) open.over = line.over;
      }
      openOf.delete(line.sessionId);
    }
    if (line.kind === 'leave') continue;
    const next: Segment = { sessionId: line.sessionId, from: line.at, ms: Math.max(0, now - Date.parse(line.at)), reason: reasonLabel(line) };
    if (line.prRef !== undefined) next.prRef = line.prRef;
    if (line.atStart === true) next.atStart = true;
    segments.push(next);
    openOf.set(line.sessionId, next);
  }

  const byReason: [string, { stretches: number; totalMs: number; longestMs: number }][] = [];
  const reasons = new Map<string, { stretches: number; totalMs: number; longestMs: number }>();
  for (const segment of segments) {
    const each = reasons.get(segment.reason) ?? { stretches: 0, totalMs: 0, longestMs: 0 };
    each.stretches += 1;
    each.totalMs += segment.ms;
    each.longestMs = Math.max(each.longestMs, segment.ms);
    reasons.set(segment.reason, each);
  }
  byReason.push(...reasons);
  const won = new Map<string, number>();
  for (const line of chosen) if (line.kind !== 'leave') won.set(line.won ?? 'unknown', (won.get(line.won ?? 'unknown') ?? 0) + 1);

  const polls = lines.filter((line): line is PollLine => line.kind === 'poll');
  const byRelation = new Map<string, { polls: number; failed: number; skipped: number }>();
  let failedSearches = 0;
  let skippedTotal = 0;
  for (const poll of polls) {
    for (const [relation, counts] of Object.entries(poll.searches)) {
      const each = byRelation.get(relation) ?? { polls: 0, failed: 0, skipped: 0 };
      each.polls += 1;
      if (counts.failed) {
        each.failed += 1;
        failedSearches += 1;
      }
      each.skipped += counts.skipped;
      skippedTotal += counts.skipped;
      byRelation.set(relation, each);
    }
  }

  const report: DiagnosticsReport = {
    days,
    lines: lines.length,
    sessions: new Set(chosen.map((line) => line.sessionId)).size,
    enters: chosen.filter((line) => line.kind === 'enter').length,
    byReason: sortBy(byReason, (each) => each.stretches),
    byWon: sortBy([...won], (count) => count),
    open: segments.filter((segment) => segment.to === undefined).length,
    segments,
    polls: { logged: polls.length, failedSearches, skippedTotal, byRelation: Object.fromEntries(byRelation) },
  };
  const latest = polls.at(-1);
  if (latest !== undefined) report.polls.latest = latest.searches;
  if (session !== undefined) report.timeline = chosen;
  return report;
}

/** A duration as `3h 20m`, `45m` or `20s`. */
export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** The report as text for a terminal. Everything in it is an id or a fixed word. */
export function formatReport(report: DiagnosticsReport): string {
  const out: string[] = [];
  out.push(`Needs you in the last ${report.days} days: ${report.enters} entries on ${report.sessions} sessions, ${report.open} still in.\n`);
  const reasons = Object.entries(report.byReason);
  if (reasons.length > 0) {
    out.push('\nBy reason (stretches, total time, longest)\n');
    for (const [name, each] of reasons) out.push(`  ${name.padEnd(26)} ${String(each.stretches).padStart(4)}  ${duration(each.totalMs).padStart(8)}  ${duration(each.longestMs).padStart(8)}\n`);
  }
  const won = Object.entries(report.byWon);
  if (won.length > 0) out.push(`\nWhich one the row explained\n${won.map(([name, count]) => `  ${name.padEnd(26)} ${String(count).padStart(4)}\n`).join('')}`);
  const polls = Object.entries(report.polls.byRelation);
  if (report.polls.logged > 0) {
    out.push(`\nPR polls logged (only when the counts changed): ${report.polls.logged}, ${report.polls.failedSearches} failed searches, ${report.polls.skippedTotal} skipped as reviewed already\n`);
    for (const [name, each] of polls) out.push(`  ${name.padEnd(18)} ${String(each.polls).padStart(4)} polls  ${String(each.failed).padStart(3)} failed  ${String(each.skipped).padStart(4)} skipped\n`);
    if (report.polls.latest !== undefined) {
      const latest = Object.entries(report.polls.latest).map(([name, each]) => `${name} ${each.failed ? 'failed' : `${each.listed} listed, ${each.skipped} skipped`}`);
      out.push(`  latest: ${latest.join('; ')}\n`);
    }
  }
  if (report.timeline !== undefined) {
    out.push('\nTimeline\n');
    for (const line of report.timeline) {
      const parts = [line.kind.padEnd(6), `own=${line.own ?? '-'}`, `pr=${line.prNeed ?? '-'}${line.prRef === undefined ? '' : ` ${line.prRef}`}`, `won=${line.won ?? '-'}`];
      if (line.setAside !== undefined) parts.push(`set-aside=${line.setAside}`);
      if (line.over !== undefined) parts.push(`over=${line.over}`);
      if (line.atStart === true) parts.push('at-start');
      out.push(`  ${line.at.slice(0, 19)} ${parts.join(' ')}\n`);
    }
  } else if (report.segments.length > 0) {
    out.push('\nLongest stretches\n');
    for (const segment of [...report.segments].sort((a, b) => b.ms - a.ms).slice(0, 15)) {
      const end = segment.to === undefined ? 'still in' : (segment.over ?? segment.setAside ?? 'left');
      out.push(`  ${segment.from.slice(0, 16)} ${segment.sessionId.slice(0, 8)} ${segment.reason.padEnd(26)} ${duration(segment.ms).padStart(8)}  ${segment.prRef ?? ''} ${end}\n`);
    }
  }
  return out.join('');
}
