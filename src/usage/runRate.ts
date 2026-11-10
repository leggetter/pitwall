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
//   RUN_RATE_MIN_SPAN_HOURS: 'thin' before.
import {
  RUN_RATE_AHEAD_POINTS,
  RUN_RATE_MIN_SPAN_HOURS,
  USAGE_AMBER_PERCENT,
  USAGE_RED_PERCENT,
  WEEKDAYS,
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
  let line: number;
  if (!pastTarget) line = targetAt > start ? (target.percent * (now - start)) / (targetAt - start) : target.percent;
  else line = resetsAt > targetAt ? target.percent + ((100 - target.percent) * (now - targetAt)) / (resetsAt - targetAt) : 100;
  const points = used - line;
  return { targetAt: new Date(targetAt).toISOString(), line: round1(line), points: round1(points), ahead: points >= RUN_RATE_AHEAD_POINTS, pastTarget };
}

/** One decimal, and never -0. */
const round1 = (n: number) => Math.round(n * 10) / 10 + 0;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * When the week of `reading` would reach 100%, from `history`, the readings kept (any week's: only
 * this week's are used). Never throws.
 */
export function project(reading: WeekReading, history: readonly WeekReading[]): RunRateProjection {
  if (reading.used >= 100) return { status: 'used-up' };
  const start = reading.resetsAt - WEEK_MS;
  const elapsed = reading.at - start;
  // This week's readings up to this one, with the reading itself.
  const week = history.filter((r) => Math.abs(r.resetsAt - reading.resetsAt) <= SAME_RESET_MS && r.at >= start && r.at <= reading.at);
  const base = [...week, reading].filter((r) => r.at >= reading.at - DAY_RATE_MS).reduce((a, b) => (b.at < a.at ? b : a), reading);
  const span = reading.at - base.at;
  if (elapsed < MIN_SPAN_MS || span < MIN_SPAN_MS) return { status: 'thin' };
  const hours = (ms: number) => ms / HOUR_MS;
  // The week since its reset, where it was 0: only this reading's rounding.
  const weekLow = Math.max(0, reading.used - ROUNDING) / hours(elapsed);
  const weekHigh = (reading.used + ROUNDING) / hours(elapsed);
  // The last day: both readings' rounding. A fall (a correction) counts as no use.
  const rise = reading.used - base.used;
  const dayLow = Math.max(0, rise - 2 * ROUNDING) / hours(span);
  const dayHigh = Math.max(0, rise + 2 * ROUNDING) / hours(span);
  const low = Math.min(weekLow, dayLow);
  const high = Math.max(weekHigh, dayHigh);
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
