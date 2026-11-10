// The run rate against a weekend reserve (W159): pitwall's own arithmetic on the plan's percentages
// (W157's `/usage` read), with no model call. PLAN.md's W159 item has the design.
//
// - The level: amber at USAGE_AMBER_PERCENT, red at USAGE_RED_PERCENT, for either window.
// - The pace: the week runs from its reset less 7 days to its reset. The target (the config file's
//   `runRate`, 80% by Friday 18:00 local time unless it says otherwise) falls once in it. The line goes
//   from 0 at the start to the target's percent at the target's time, then on to 100 at the reset;
//   a week over the line by RUN_RATE_AHEAD_POINTS or more is ahead of pace.
// - The projection: when the week would reach 100%, as a range, from the week's own readings
//   (readings.ts), never the transcripts' tokens. Two rates: the week's average since its reset,
//   where it was 0, and the last day's, from the earliest reading of the last 24 hours. Each is widened
//   by the figures' rounding (the server sends whole percentages: half a point on each reading), and
//   the range is the slower of the two low ends to the faster of the two high ends. A burst lifts the
//   day's rate and the range's early end; a quiet spell lowers it and the late end; a straight line
//   from either alone would overstate or understate. Only once the readings this week span
//   RUN_RATE_MIN_SPAN_HOURS: 'thin' before. With no span that long in the last day, the week's
//   average alone.
// - The chart (W181): the same reading's week as numbers, for the Usage view to draw. The readings,
//   at most RUN_RATE_CHART_POINTS; the line's three points; the trend from the reading at the
//   projection's two rates and their middle, each to where it reaches 100% or the reset; and where the
//   middle first crosses the line.
import {
  RUN_RATE_AHEAD_POINTS,
  RUN_RATE_CHART_POINTS,
  RUN_RATE_MIN_SPAN_HOURS,
  USAGE_AMBER_PERCENT,
  USAGE_RED_PERCENT,
  WEEKDAYS,
  type RunRateChart,
  type RunRateChartPoint,
  type RunRatePace,
  type RunRateProjection,
  type RunRateTarget,
  type UsageLevel,
  type Weekday,
} from '../shared/protocol.js';

export const WEEK_MS = 7 * 86_400_000;
const HOUR_MS = 3_600_000;
/** The day's rate looks back this far. */
export const DAY_RATE_MS = 24 * HOUR_MS;
export const MIN_SPAN_MS = RUN_RATE_MIN_SPAN_HOURS * HOUR_MS;
/** Two resets within this are the same week's: the server's jitter is under a second (spike 013). */
export const SAME_RESET_MS = 60_000;
/** Each reading is a whole percentage, so it may be this far from the true figure. */
const ROUNDING = 0.5;

export const DEFAULT_RUN_RATE_TARGET: RunRateTarget = { percent: 80, day: 'friday', time: '18:00' };

/** One reading of the plan's week: when (Unix ms), its percentage, and its reset (Unix ms). */
export interface WeekReading {
  at: number;
  used: number;
  resetsAt: number;
}

export function levelOf(percent: number): UsageLevel {
  if (percent >= USAGE_RED_PERCENT) return 'red';
  if (percent >= USAGE_AMBER_PERCENT) return 'amber';
  return 'normal';
}

/** The first time after `start`, up to `end`, that's the target's day and time, local time; `end` if none. */
export function targetTime(start: number, end: number, target: RunRateTarget): number {
  const [hours, minutes] = target.time.split(':').map(Number) as [number, number];
  const day = WEEKDAYS.indexOf(target.day);
  const from = new Date(start);
  for (let offset = 0; offset <= 8; offset++) {
    // Built from the local date's parts, so a change of clocks in the week keeps 18:00 at 18:00.
    const candidate = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset, hours, minutes, 0, 0);
    const at = candidate.getTime();
    if (candidate.getDay() === day && at > start && at <= end) return at;
  }
  return end;
}

/** The pace of a reading of `used` at `at` in the week that resets at `resetsAt` (Unix ms). */
export function paceAt(at: number, used: number, resetsAt: number, target: RunRateTarget): RunRatePace {
  const start = resetsAt - WEEK_MS;
  const targetAt = targetTime(start, resetsAt, target);
  const now = Math.min(Math.max(at, start), resetsAt);
  const pastTarget = now > targetAt;
  const line = lineAt(now, start, targetAt, resetsAt, target.percent);
  const points = used - line;
  return { targetAt: new Date(targetAt).toISOString(), line: round1(line), points: round1(points), ahead: points >= RUN_RATE_AHEAD_POINTS, pastTarget };
}

/**
 * The line at `at`, unrounded: from 0 at `start` to `percent` at `targetAt`, then on to 100 at
 * `resetsAt`.
 */
function lineAt(at: number, start: number, targetAt: number, resetsAt: number, percent: number): number {
  const now = Math.min(Math.max(at, start), resetsAt);
  if (now <= targetAt) return targetAt > start ? (percent * (now - start)) / (targetAt - start) : percent;
  return resetsAt > targetAt ? percent + ((100 - percent) * (now - targetAt)) / (resetsAt - targetAt) : 100;
}

/** One decimal, and never -0. */
const round1 = (n: number) => Math.round(n * 10) / 10 + 0;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * When the week of `reading` would reach 100%, from `history`, the readings kept (any week's: only
 * this week's are used). Never throws.
 */
export function project(reading: WeekReading, history: readonly WeekReading[]): RunRateProjection {
  const rates = rangeRates(reading, history);
  if (rates.status !== 'rates') return rates;
  const { low, high } = rates;
  const left = 100 - reading.used;
  const earliest = reading.at + (left / high) * HOUR_MS;
  if (earliest >= reading.resetsAt) return { status: 'lasts' };
  const latest = low > 0 ? reading.at + (left / low) * HOUR_MS : Infinity;
  return {
    status: 'range',
    earliest: new Date(earliest).toISOString(),
    latest: latest >= reading.resetsAt ? null : new Date(latest).toISOString(),
    perHour: { low: round3(low), high: round3(high) },
  };
}

/** This week's readings in `history`, up to and without `reading`'s own time, oldest first. */
function weekOf(reading: WeekReading, history: readonly WeekReading[]): WeekReading[] {
  const start = reading.resetsAt - WEEK_MS;
  return history.filter((r) => Math.abs(r.resetsAt - reading.resetsAt) <= SAME_RESET_MS && r.at >= start && r.at <= reading.at);
}

/** The projection's two rates, in percentage points an hour (PLAN.md's W159 item), or why there are none. */
function rangeRates(reading: WeekReading, history: readonly WeekReading[]): { status: 'thin' } | { status: 'used-up' } | { status: 'rates'; low: number; high: number } {
  if (reading.used >= 100) return { status: 'used-up' };
  const start = reading.resetsAt - WEEK_MS;
  const elapsed = reading.at - start;
  // This week's readings up to this one, with the reading itself.
  const week = weekOf(reading, history);
  const earliestThisWeek = week.reduce((a, b) => Math.min(a, b.at), reading.at);
  if (elapsed < MIN_SPAN_MS || reading.at - earliestThisWeek < MIN_SPAN_MS) return { status: 'thin' };
  const base = [...week, reading].filter((r) => r.at >= reading.at - DAY_RATE_MS).reduce((a, b) => (b.at < a.at ? b : a), reading);
  const span = reading.at - base.at;
  const hours = (ms: number) => ms / HOUR_MS;
  // The week since its reset, where it was 0: only this reading's rounding.
  let low = Math.max(0, reading.used - ROUNDING) / hours(elapsed);
  let high = (reading.used + ROUNDING) / hours(elapsed);
  // The last day, when its readings span MIN_SPAN_MS: both readings' rounding. A fall (a correction)
  // counts as no use. Without one, as after a night with no page open, the week's average alone.
  if (span >= MIN_SPAN_MS) {
    const rise = reading.used - base.used;
    low = Math.min(low, Math.max(0, rise - 2 * ROUNDING) / hours(span));
    high = Math.max(high, Math.max(0, rise + 2 * ROUNDING) / hours(span));
  }
  return { status: 'rates', low, high };
}

// --- The chart (W181) -----------------------------------------------------------------------------

/**
 * The run rate as a chart (W181): the week's readings, downsampled to at most RUN_RATE_CHART_POINTS,
 * the line, the trend at the projection's rates and where its middle crosses the line. From the same
 * reading as the pace and the projection, so the chart and the sentences agree. Never throws.
 */
export function chartOf(reading: WeekReading, history: readonly WeekReading[], target: RunRateTarget): RunRateChart {
  const start = reading.resetsAt - WEEK_MS;
  const end = reading.resetsAt;
  const targetAt = targetTime(start, end, target);
  const lineOf = (at: number) => lineAt(at, start, targetAt, end, target.percent);
  const points: RunRateChartPoint[] = [{ at: start, percent: 0 }];
  if (targetAt > start && targetAt < end) points.push({ at: targetAt, percent: target.percent });
  points.push({ at: end, percent: 100 });

  // The last reading of each slot of the week, the reading itself last.
  const slot = WEEK_MS / RUN_RATE_CHART_POINTS;
  const bySlot = new Map<number, WeekReading>();
  for (const r of weekOf(reading, history)) {
    if (r.at >= reading.at) continue;
    const key = Math.floor((r.at - start) / slot);
    const kept = bySlot.get(key);
    if (kept === undefined || r.at >= kept.at) bySlot.set(key, r);
  }
  bySlot.delete(Math.floor((reading.at - start) / slot));
  const readings = [...bySlot.values()]
    .sort((a, b) => a.at - b.at)
    .slice(-(RUN_RATE_CHART_POINTS - 1))
    .map((r) => ({ at: r.at, percent: r.used }));
  readings.push({ at: reading.at, percent: reading.used });

  const rates = rangeRates(reading, history);
  if (rates.status !== 'rates') return { start, end, at: reading.at, readings, line: points, trend: null, crossesLine: null };
  const mid = (rates.low + rates.high) / 2;
  /** Where the trend at `rate` reaches 100%, or the reset first. */
  const endOf = (rate: number): RunRateChartPoint => {
    const reaches = rate > 0 ? reading.at + ((100 - reading.used) / rate) * HOUR_MS : Infinity;
    if (reaches < end) return { at: Math.round(reaches), percent: 100 };
    return { at: end, percent: round1(reading.used + (rate * (end - reading.at)) / HOUR_MS) };
  };
  const trend = { low: endOf(rates.low), mid: endOf(mid), high: endOf(rates.high) };
  return { start, end, at: reading.at, readings, line: points, trend, crossesLine: crossing(reading, mid, trend.mid.at, targetAt, end, lineOf) };
}

/**
 * When the trend at `rate` from `reading`, flat at 100 after `reaches`, first crosses the line after the
 * reading and before `end`; null when it doesn't, or when the reading is on the line. Both are straight
 * between the breaks, so each piece is solved exactly.
 */
function crossing(reading: WeekReading, rate: number, reaches: number, targetAt: number, end: number, lineOf: (at: number) => number): RunRateChart['crossesLine'] {
  const trendOf = (at: number) => Math.min(100, reading.used + (rate * (at - reading.at)) / HOUR_MS);
  const gap = (at: number) => trendOf(at) - lineOf(at);
  const first = gap(reading.at);
  if (first === 0) return null;
  const breaks = [...new Set([reading.at, targetAt, reaches, end])].filter((at) => at >= reading.at && at <= end).sort((a, b) => a - b);
  for (let i = 1; i < breaks.length; i++) {
    const a = breaks[i - 1]!;
    const b = breaks[i]!;
    const ga = gap(a);
    const gb = gap(b);
    if (Math.sign(gb) === Math.sign(first) || Math.sign(ga) !== Math.sign(first)) continue;
    const at = Math.round(a + ((b - a) * ga) / (ga - gb));
    // Meeting the line at the reset, where it reaches 100, isn't a crossing: the week is over.
    if (at >= end) return null;
    return { at, to: first < 0 ? 'over' : 'under' };
  }
  return null;
}

// --- The config file's `runRate` ------------------------------------------------------------------

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The config file's `runRate`: `{ "percent"?, "day"?, "time"? }`, each defaulting to
 * DEFAULT_RUN_RATE_TARGET's. `percent` a whole number from 1 to 100; `day` a weekday's English name,
 * any case; `time` HH:MM, 24-hour, local time.
 */
export function parseRunRateTarget(value: unknown, key: string, fail: (key: string, message: string) => never, unknown: (key: string) => void): RunRateTarget {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(key, 'must be an object, such as { "percent": 80, "day": "friday", "time": "18:00" }');
  }
  const entry = value as Record<string, unknown>;
  for (const name of Object.keys(entry)) if (name !== 'percent' && name !== 'day' && name !== 'time') unknown(`${key}.${name}`);
  const target: RunRateTarget = { ...DEFAULT_RUN_RATE_TARGET };
  if (Object.hasOwn(entry, 'percent')) {
    const percent = entry.percent;
    if (typeof percent !== 'number' || !Number.isInteger(percent) || percent < 1 || percent > 100) return fail(`${key}.percent`, 'must be a whole number from 1 to 100');
    target.percent = percent;
  }
  if (Object.hasOwn(entry, 'day')) {
    const day = typeof entry.day === 'string' ? entry.day.toLowerCase() : undefined;
    if (day === undefined || !(WEEKDAYS as readonly string[]).includes(day)) return fail(`${key}.day`, 'must be a day of the week, such as "friday"');
    target.day = day as Weekday;
  }
  if (Object.hasOwn(entry, 'time')) {
    if (typeof entry.time !== 'string' || !TIME.test(entry.time)) return fail(`${key}.time`, 'must be a time of day as HH:MM, 24-hour, such as "18:00"');
    target.time = entry.time;
  }
  return target;
}
