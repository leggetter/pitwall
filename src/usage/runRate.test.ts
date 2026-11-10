// The run rate (W159): the level, the target in the week, the pace against the weekend reserve's line,
// and the projection's range, from made-up readings. Times are built from local dates, so the tests
// hold in any time zone.
import { describe, expect, it } from 'vitest';
import type { RateLimits } from './rateLimits.js';
import { RUN_RATE_CHART_POINTS } from '../shared/protocol.js';
import { chartOf, DEFAULT_RUN_RATE_TARGET, levelOf, paceAt, project, targetTime, WEEK_MS, type WeekReading } from './runRate.js';
import { chartFor, FALLBACK_MAX_MS, runRateOf } from './service.js';

const HOUR = 3_600_000;
/** The week resets on Sunday 15 Nov 2026 at 12:00, local time, so it started Sunday 8 Nov at 12:00. */
const RESET = new Date(2026, 10, 15, 12, 0).getTime();
const START = RESET - WEEK_MS;
const FRIDAY = new Date(2026, 10, 13, 18, 0).getTime();
const at = (hours: number) => START + hours * HOUR;

/** Hourly readings from `from` to `to` hours into the week, each the whole percentage `used(h)` rounds to. */
function readings(from: number, to: number, used: (h: number) => number, resetsAt = RESET): WeekReading[] {
  const out: WeekReading[] = [];
  for (let h = from; h <= to; h++) out.push({ at: at(h), used: Math.round(used(h)), resetsAt });
  return out;
}

describe('the level', () => {
  it('is amber from 70% and red from 90%', () => {
    expect([0, 69.9, 70, 89.9, 90, 140].map(levelOf)).toEqual(['normal', 'normal', 'amber', 'amber', 'red', 'red']);
  });
});

describe('the target in the week', () => {
  it('is the week’s one Friday 18:00, local time', () => {
    expect(targetTime(START, RESET, DEFAULT_RUN_RATE_TARGET)).toBe(FRIDAY);
  });

  it('is the Friday after a Thursday reset, and the reset itself when the week resets at the target', () => {
    const thursday = new Date(2026, 10, 12, 14, 0).getTime();
    expect(targetTime(thursday, thursday + WEEK_MS, DEFAULT_RUN_RATE_TARGET)).toBe(new Date(2026, 10, 13, 18, 0).getTime());
    expect(targetTime(FRIDAY - WEEK_MS, FRIDAY, DEFAULT_RUN_RATE_TARGET)).toBe(FRIDAY);
  });

  it('takes the config file’s day and time', () => {
    expect(targetTime(START, RESET, { percent: 60, day: 'wednesday', time: '09:30' })).toBe(new Date(2026, 10, 11, 9, 30).getTime());
  });
});

describe('the pace', () => {
  const span = (FRIDAY - START) / HOUR;

  it('runs the line from 0 at the reset to 80 at the target, then on to 100 at the next reset', () => {
    expect(paceAt(START, 0, RESET, DEFAULT_RUN_RATE_TARGET)).toMatchObject({ line: 0, points: 0, ahead: false, pastTarget: false, targetAt: new Date(FRIDAY).toISOString() });
    expect(paceAt(START + (FRIDAY - START) / 2, 40, RESET, DEFAULT_RUN_RATE_TARGET)).toMatchObject({ line: 40, points: 0, ahead: false });
    expect(paceAt(FRIDAY, 80, RESET, DEFAULT_RUN_RATE_TARGET)).toMatchObject({ line: 80, pastTarget: false });
    expect(paceAt(FRIDAY + (RESET - FRIDAY) / 2, 90, RESET, DEFAULT_RUN_RATE_TARGET)).toMatchObject({ line: 90, pastTarget: true, ahead: false });
    expect(span).toBe(126);
  });

  it('is ahead from 3 points over the line, so a point of rounding doesn’t flip it', () => {
    const half = START + (FRIDAY - START) / 2;
    expect(paceAt(half, 42, RESET, DEFAULT_RUN_RATE_TARGET)).toMatchObject({ points: 2, ahead: false });
    expect(paceAt(half, 43, RESET, DEFAULT_RUN_RATE_TARGET)).toMatchObject({ points: 3, ahead: true });
    expect(paceAt(half, 30, RESET, DEFAULT_RUN_RATE_TARGET)).toMatchObject({ points: -10, ahead: false });
  });

  it('just after the reset, a fresh week is on its line', () => {
    expect(paceAt(START + 60_000, 0, RESET, DEFAULT_RUN_RATE_TARGET)).toMatchObject({ points: 0, ahead: false });
  });
});

describe('the projection', () => {
  it('is thin until the week’s readings span 6 hours', () => {
    // Three hours into the week.
    const early: WeekReading = { at: at(3), used: 4, resetsAt: RESET };
    expect(project(early, readings(0, 3, (h) => h))).toEqual({ status: 'thin' });
    // Three days in, but only one reading: nothing to take the last day's rate from.
    const lone: WeekReading = { at: at(72), used: 30, resetsAt: RESET };
    expect(project(lone, [])).toEqual({ status: 'thin' });
    expect(project(lone, readings(68, 72, (h) => h / 2.4))).toEqual({ status: 'thin' });
  });

  it('a steady rate: a range around its line, both ends before the reset', () => {
    const history = readings(40, 72, (h) => 0.8 * h);
    const now = history.at(-1)!;
    const result = project(now, history);
    expect(result.status).toBe('range');
    if (result.status !== 'range') return;
    const earliest = Date.parse(result.earliest);
    const latest = Date.parse(result.latest!);
    // 42 points left at 0.8 an hour is 52.5 hours: the range holds it.
    const straight = now.at + (42 / 0.8) * HOUR;
    expect(earliest).toBeLessThan(straight);
    expect(latest).toBeGreaterThan(straight);
    expect(latest).toBeLessThan(RESET);
    expect(result.perHour.low).toBeLessThan(0.8);
    expect(result.perHour.high).toBeGreaterThan(0.8);
  });

  it('after a burst: the early end comes from the last day, not the burst alone, and the late end from the week', () => {
    // 0.3 points an hour for 60 hours, then 2 an hour for 6.
    const used = (h: number) => (h <= 60 ? 0.3 * h : 18 + 2 * (h - 60));
    const history = readings(30, 66, used);
    const now = history.at(-1)!;
    expect(now.used).toBe(30);
    const result = project(now, history);
    expect(result.status).toBe('range');
    if (result.status !== 'range') return;
    // A straight line from the burst would say 35 hours; the day's rate is far slower.
    expect(Date.parse(result.earliest)).toBeGreaterThan(now.at + 35 * HOUR);
    expect(Date.parse(result.earliest)).toBeLessThan(RESET);
    // At the week's average it lasts past the reset.
    expect(result.latest).toBeNull();
  });

  it('a quiet day: the slower rate is none, so the late end is after the reset', () => {
    const history = readings(40, 96, (h) => (h <= 72 ? 0.9 * h : 0.9 * 72));
    const result = project(history.at(-1)!, history);
    expect(result).toMatchObject({ status: 'range', latest: null });
  });

  it('lasts when even the faster rate reaches the reset first, and is used up at 100%', () => {
    const history = readings(40, 72, (h) => 0.2 * h);
    expect(project(history.at(-1)!, history)).toEqual({ status: 'lasts' });
    expect(project({ at: at(100), used: 100, resetsAt: RESET }, [])).toEqual({ status: 'used-up' });
  });

  it('with no 6 hours of readings in the last day, the week’s average alone', () => {
    // Read at 30 hours, then nothing until 72: a night and a day with no page open.
    const history = [{ at: at(30), used: 24, resetsAt: RESET }];
    const now: WeekReading = { at: at(72), used: 58, resetsAt: RESET };
    const result = project(now, history);
    expect(result.status).toBe('range');
    if (result.status !== 'range') return;
    expect(result.perHour).toEqual({ low: Math.round((57.5 / 72) * 1000) / 1000, high: Math.round((58.5 / 72) * 1000) / 1000 });
  });

  it('leaves out the last week’s readings: across the reset, the new week is thin', () => {
    const previous = readings(150, 168, () => 92, RESET - WEEK_MS).map((r) => ({ ...r, at: r.at - WEEK_MS }));
    const now: WeekReading = { at: at(4), used: 3, resetsAt: RESET };
    expect(project(now, [...previous, ...readings(0, 4, (h) => h * 0.75)])).toEqual({ status: 'thin' });
    // Once this week's readings span 6 hours, they alone count: the last week's 92% doesn't make it negative.
    const later = readings(0, 10, (h) => h * 0.75);
    const result = project(later.at(-1)!, [...previous, ...later]);
    expect(result.status).not.toBe('thin');
  });
});

describe('the run rate', () => {
  const available = (used: number, readAt: number, five: number | null = null): RateLimits => ({
    status: 'available',
    readAt,
    sevenDay: { usedPercentage: used, resetsAt: RESET / 1000 },
    fiveHour: five === null ? null : { usedPercentage: five, resetsAt: (readAt + 2 * HOUR) / 1000 },
  });

  it('gives the week its level, pace and projection, and the five hours only when present', () => {
    const history = readings(40, 72, (h) => 1.1 * h);
    const rate = runRateOf(available(79, at(72)), history, DEFAULT_RUN_RATE_TARGET, at(72));
    expect(rate).toMatchObject({ status: 'available', fiveHour: null, target: DEFAULT_RUN_RATE_TARGET });
    if (rate.status !== 'available') return;
    expect(rate.sevenDay).toMatchObject({ usedPercentage: 79, level: 'amber', pace: { ahead: true }, projection: { status: 'range' } });
    expect(rate.fallback).toBeUndefined();
    const withFive = runRateOf(available(20, at(72), 93), [], DEFAULT_RUN_RATE_TARGET, at(72));
    expect(withFive).toMatchObject({ fiveHour: { usedPercentage: 93, level: 'red' } });
  });

  it('a week with no reset has its figure but no pace', () => {
    const limits: RateLimits = { status: 'available', readAt: at(10), sevenDay: { usedPercentage: 12, resetsAt: null }, fiveHour: null };
    expect(runRateOf(limits, [], DEFAULT_RUN_RATE_TARGET, at(10))).toMatchObject({ sevenDay: { usedPercentage: 12, resetsAt: null, pace: null, projection: null } });
  });

  it('when the read fails: the last kept reading, marked, under 6 hours old and of a week that hasn’t reset; else unavailable', () => {
    const history = readings(40, 72, (h) => 0.5 * h);
    const failed = (readAt: number): RateLimits => ({ status: 'unavailable', readAt, reason: 'timeout' });
    const soon = runRateOf(failed(at(73)), history, DEFAULT_RUN_RATE_TARGET, at(73));
    expect(soon).toMatchObject({ status: 'available', readAt: new Date(at(72)).toISOString(), fallback: { reason: 'timeout' }, fiveHour: null, sevenDay: { usedPercentage: 36 } });
    const late = at(72) + FALLBACK_MAX_MS + 1;
    expect(runRateOf(failed(late), history, DEFAULT_RUN_RATE_TARGET, late)).toEqual({ status: 'unavailable', readAt: new Date(late).toISOString(), reason: 'timeout' });
    const reset = [{ at: RESET - HOUR, used: 99, resetsAt: RESET }];
    expect(runRateOf(failed(RESET + 1), reset, DEFAULT_RUN_RATE_TARGET, RESET + 1)).toMatchObject({ status: 'unavailable' });
    // A reading from the future, as a planted file could hold, never stands in.
    const planted = [{ at: at(73) + 23 * HOUR, used: 999, resetsAt: RESET }];
    expect(runRateOf(failed(at(73)), planted, DEFAULT_RUN_RATE_TARGET, at(73))).toMatchObject({ status: 'unavailable', reason: 'timeout' });
    expect(runRateOf({ status: 'unavailable', readAt: at(1), reason: 'off' }, history, DEFAULT_RUN_RATE_TARGET, at(1))).toEqual({ status: 'off' });
  });
});

describe('the chart (W181)', () => {
  const T = DEFAULT_RUN_RATE_TARGET;
  /** Every 5 minutes from `from` to `to` hours into the week, as a page open all along would read. */
  function dense(from: number, to: number, used: (h: number) => number): WeekReading[] {
    const out: WeekReading[] = [];
    for (let m = from * 60; m <= to * 60; m += 5) out.push({ at: at(m / 60), used: Math.round(used(m / 60)), resetsAt: RESET });
    return out;
  }

  it('spans the week, with the line’s three points, and its readings bounded and ending at the reading', () => {
    const history = dense(0, 150, (h) => 0.5 * h);
    expect(history.length).toBeGreaterThan(1800);
    const now = history.at(-1)!;
    const chart = chartOf(now, history, T);
    expect([chart.start, chart.end, chart.at]).toEqual([START, RESET, now.at]);
    expect(chart.line).toEqual([
      { at: START, percent: 0 },
      { at: FRIDAY, percent: 80 },
      { at: RESET, percent: 100 },
    ]);
    expect(chart.readings.length).toBeLessThanOrEqual(RUN_RATE_CHART_POINTS);
    expect(chart.readings.length).toBeGreaterThan(290);
    expect(chart.readings.at(-1)).toEqual({ at: now.at, percent: 75 });
    expect(chart.readings.every((p, i, all) => i === 0 || p.at > all[i - 1]!.at)).toBe(true);
    // Numbers only: a time and a percentage.
    expect(Object.keys(chart.readings[0]!).sort()).toEqual(['at', 'percent']);
  });

  it('leaves out other weeks’ readings and any after the reading', () => {
    const previous = { at: START - HOUR, used: 90, resetsAt: START };
    const later = { at: at(80), used: 50, resetsAt: RESET };
    const history = [previous, ...readings(40, 72, (h) => 0.5 * h), later];
    const chart = chartOf(history.at(-2)!, history, T);
    expect(chart.readings.map((p) => p.at)).toEqual(readings(40, 72, () => 0).map((r) => r.at));
  });

  it('thin history: the readings, no trend, no crossing', () => {
    const history = readings(0, 3, (h) => h);
    const chart = chartOf(history.at(-1)!, history, T);
    expect(chart.readings).toHaveLength(4);
    expect(chart.trend).toBeNull();
    expect(chart.crossesLine).toBeNull();
  });

  it('a steady rate: the trend’s ends agree with the projection’s range, the middle between them', () => {
    const history = readings(40, 72, (h) => 0.8 * h);
    const now = history.at(-1)!;
    const chart = chartOf(now, history, T);
    const projection = project(now, history);
    if (projection.status !== 'range' || chart.trend === null) throw new Error('expected a range and a trend');
    expect(chart.trend.high).toEqual({ at: Math.round(Date.parse(projection.earliest)), percent: 100 });
    expect(Math.abs(chart.trend.low.at - Date.parse(projection.latest!))).toBeLessThan(1000);
    expect(chart.trend.low.percent).toBe(100);
    expect(chart.trend.mid.at).toBeGreaterThan(chart.trend.high.at);
    expect(chart.trend.mid.at).toBeLessThan(chart.trend.low.at);
  });

  it('a burst: the faster end reaches 100% before the reset, the slower lasts to it below 100, and the middle crosses the line', () => {
    // Quiet at 0.2 an hour for 70 hours, then 4 an hour for 8: under the line, rising fast.
    const used = (h: number) => (h <= 70 ? 0.2 * h : 14 + 4 * (h - 70));
    const history = readings(30, 78, used);
    const now = history.at(-1)!;
    expect(now.used).toBe(46);
    const chart = chartOf(now, history, T);
    if (chart.trend === null) throw new Error('expected a trend');
    expect(chart.trend.high.percent).toBe(100);
    expect(chart.trend.high.at).toBeLessThan(RESET);
    expect(chart.trend.low.at).toBe(RESET);
    expect(chart.trend.low.percent).toBeLessThan(100);
    // The reading is under the line (about 49.5 at 78 hours); the middle rate goes over it later.
    expect(paceAt(now.at, now.used, RESET, T).points).toBeLessThan(0);
    expect(chart.crossesLine?.to).toBe('over');
    const crossing = chart.crossesLine!.at;
    expect(crossing).toBeGreaterThan(now.at);
    expect(crossing).toBeLessThan(RESET);
    // At the crossing, the middle and the line agree.
    const mid = now.used + ((chart.trend.mid.percent - now.used) * (crossing - now.at)) / (chart.trend.mid.at - now.at);
    expect(Math.abs(mid - paceAt(crossing, 0, RESET, T).line)).toBeLessThan(0.1);
  });

  it('ahead of pace and slowing: the middle crosses back under the line', () => {
    // 1 an hour for 40 hours, then 0.3 an hour: well over the line, then slower than it.
    const history = readings(20, 64, (h) => (h <= 40 ? h : 40 + 0.3 * (h - 40)));
    const now = history.at(-1)!;
    expect(paceAt(now.at, now.used, RESET, T).points).toBeGreaterThan(0);
    const chart = chartOf(now, history, T);
    expect(chart.crossesLine?.to).toBe('under');
  });

  it('past 100%: no trend, the readings still drawn', () => {
    const history = readings(60, 100, (h) => h);
    const now = history.at(-1)!;
    expect(now.used).toBe(100);
    const chart = chartOf(now, history, T);
    expect(chart.trend).toBeNull();
    expect(chart.crossesLine).toBeNull();
    expect(chart.readings.at(-1)).toEqual({ at: now.at, percent: 100 });
  });

  it('the target time already passed: the line still runs on to 100 at the reset, and the trend from the reading', () => {
    // Saturday 10:00, 160 hours in: past Friday 18:00.
    const history = readings(130, 160, (h) => 0.55 * h);
    const now = history.at(-1)!;
    expect(now.at).toBeGreaterThan(FRIDAY);
    const chart = chartOf(now, history, T);
    expect(chart.line.at(-1)).toEqual({ at: RESET, percent: 100 });
    if (chart.trend === null) throw new Error('expected a trend');
    expect(chart.trend.low.at).toBeGreaterThan(now.at);
    expect(chart.trend.low.at).toBeLessThanOrEqual(RESET);
  });

  it('a week that resets at the target: the line goes straight to the target at the reset', () => {
    const resetAtTarget = FRIDAY;
    const reading = { at: resetAtTarget - 10 * HOUR, used: 50, resetsAt: resetAtTarget };
    const chart = chartOf(reading, [reading], T);
    expect(chart.line).toEqual([
      { at: resetAtTarget - WEEK_MS, percent: 0 },
      { at: resetAtTarget, percent: 100 },
    ]);
  });

  it('chartFor: from the run rate’s reading, the stand-in’s too; none without the week’s reset', () => {
    const history = readings(40, 72, (h) => 0.5 * h);
    const failed: RateLimits = { status: 'unavailable', readAt: at(73), reason: 'timeout' };
    const rate = runRateOf(failed, history, T, at(73));
    expect(chartFor(rate, history, T)?.at).toBe(at(72));
    expect(chartFor({ status: 'off' }, history, T)).toBeUndefined();
    const noReset: RateLimits = { status: 'available', readAt: at(10), sevenDay: { usedPercentage: 12, resetsAt: null }, fiveHour: null };
    expect(chartFor(runRateOf(noReset, [], T, at(10)), [], T)).toBeUndefined();
  });
});
