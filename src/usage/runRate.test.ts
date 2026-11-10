// The run rate (W159): the level, the target in the week, the pace against the weekend reserve's line,
// and the projection's range, from made-up readings. Times are built from local dates, so the tests
// hold in any time zone.
import { describe, expect, it } from 'vitest';
import type { RateLimits } from './rateLimits.js';
import { DEFAULT_RUN_RATE_TARGET, levelOf, paceAt, project, targetTime, WEEK_MS, type WeekReading } from './runRate.js';
import { FALLBACK_MAX_MS, runRateOf } from './service.js';

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
    expect(runRateOf({ status: 'unavailable', readAt: at(1), reason: 'off' }, history, DEFAULT_RUN_RATE_TARGET, at(1))).toEqual({ status: 'off' });
  });
});
