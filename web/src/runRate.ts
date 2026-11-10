// The header's run rate (W159, docs/design-system.md, 4: Usage): the plan's week, and the five hours'
// when the server sends it, against the weekend reserve. Reading the server's answer defensively, when
// to ask for it, and its words.
//
// When to ask: only while the snapshot says it's on (`planUsage`, absent with `--no-usage`), the
// connection is live and this page is visible, once as that starts and every RUN_RATE_POLL_MS while it
// lasts. A hidden page never asks, and the server never reads on its own, so with no page open pitwall
// runs no `/usage`. The server reads through its reader's 5-minute cache however many pages ask.
//
// Never a stale figure as current: a figure older than RUN_RATE_AGE_SHOWN_MS says how old, one of a
// week that has since reset isn't shown, and while the connection is down the header shows none.

import { useEffect, useState } from 'react';
import {
  RUN_RATE_AGE_SHOWN_MS,
  RUN_RATE_PATH,
  RUN_RATE_POLL_MS,
  WEEKDAYS,
  type RunRate,
  type RunRatePace,
  type RunRateProjection,
  type RunRateTarget,
  type RunRateWeek,
  type RunRateWindow,
  type UsageLevel,
} from '../../src/shared/protocol.js';
import type { ApiClient } from './api.js';
import { resetText } from './usage.js';

// --- Reading the answer ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isPercent = (value: unknown): value is number => isNumber(value) && value >= 0 && value <= 1000;
const isTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const isLevel = (value: unknown): value is UsageLevel => value === 'normal' || value === 'amber' || value === 'red';

function isWindow(value: unknown): value is RunRateWindow {
  return isRecord(value) && isPercent(value.usedPercentage) && (value.resetsAt === null || isTime(value.resetsAt)) && isLevel(value.level);
}

function isPace(value: unknown): value is RunRatePace {
  return isRecord(value) && isTime(value.targetAt) && isNumber(value.line) && isNumber(value.points) && typeof value.ahead === 'boolean' && typeof value.pastTarget === 'boolean';
}

function isProjection(value: unknown): value is RunRateProjection {
  if (!isRecord(value)) return false;
  if (value.status === 'thin' || value.status === 'used-up' || value.status === 'lasts') return true;
  return (
    value.status === 'range' &&
    isTime(value.earliest) &&
    (value.latest === null || isTime(value.latest)) &&
    isRecord(value.perHour) &&
    isNumber(value.perHour.low) &&
    isNumber(value.perHour.high)
  );
}

function isWeek(value: unknown): value is RunRateWeek {
  if (!isWindow(value)) return false;
  const { pace, projection } = value as unknown as Record<string, unknown>;
  return (pace === null || isPace(pace)) && (projection === null || isProjection(projection));
}

function isTarget(value: unknown): value is RunRateTarget {
  return isRecord(value) && isNumber(value.percent) && (WEEKDAYS as readonly unknown[]).includes(value.day) && typeof value.time === 'string' && /^\d{2}:\d{2}$/.test(value.time);
}

/** The server's answer, when it has the shape this page reads; undefined otherwise. */
export function asRunRate(value: unknown): RunRate | undefined {
  if (!isRecord(value)) return undefined;
  if (value.status === 'off') return { status: 'off' };
  if (value.status === 'unavailable') return isTime(value.readAt) && typeof value.reason === 'string' ? { status: 'unavailable', readAt: value.readAt, reason: value.reason } : undefined;
  if (value.status !== 'available' || !isTime(value.readAt) || !isTarget(value.target)) return undefined;
  if (value.sevenDay !== null && !isWeek(value.sevenDay)) return undefined;
  if (value.fiveHour !== null && !isWindow(value.fiveHour)) return undefined;
  if (value.fallback !== undefined && !(isRecord(value.fallback) && typeof value.fallback.reason === 'string')) return undefined;
  return value as unknown as RunRate;
}

// --- When to ask ----------------------------------------------------------------------------------

export interface VisibilityEnv {
  visible(): boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

const browserVisibility: VisibilityEnv = {
  visible: () => document.visibilityState !== 'hidden',
  addEventListener: (type, listener) => document.addEventListener(type, listener),
  removeEventListener: (type, listener) => document.removeEventListener(type, listener),
};

/**
 * The run rate, asked for while `on` and the page is visible: at once, then every RUN_RATE_POLL_MS.
 * Undefined while off or before the first answer. A failed ask keeps the last answer, whose age the
 * header then shows; a 404 (no usage source) is 'off'.
 */
export function useRunRate(api: ApiClient | undefined, on: boolean, visibility: VisibilityEnv = browserVisibility): RunRate | undefined {
  const [rate, setRate] = useState<RunRate | undefined>(undefined);
  useEffect(() => {
    if (api === undefined || !on) return;
    let abort: AbortController | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const ask = () => {
      abort?.abort();
      const current = new AbortController();
      abort = current;
      void api.get(RUN_RATE_PATH, { signal: current.signal }).then((result) => {
        if (current.signal.aborted) return;
        if (result.kind === 'ok') {
          const answer = asRunRate(result.body);
          if (answer !== undefined) setRate(answer);
        } else if (result.kind === 'failed' && result.status === 404) setRate({ status: 'off' });
      });
    };
    const start = () => {
      if (timer !== undefined) return;
      ask();
      timer = setInterval(ask, RUN_RATE_POLL_MS);
    };
    const stop = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      abort?.abort();
    };
    const follow = () => (visibility.visible() ? start() : stop());
    follow();
    visibility.addEventListener('visibilitychange', follow);
    return () => {
      visibility.removeEventListener('visibilitychange', follow);
      stop();
    };
  }, [api, on, visibility]);
  return on ? rate : undefined;
}

// --- Words ----------------------------------------------------------------------------------------

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** "Fri 18:00": the target's day and time, short. */
export function targetText(target: RunRateTarget): string {
  return `${capital(target.day).slice(0, 3)} ${target.time}`;
}

/** A time as "Sat 14:00", local. */
export function dayTimeText(iso: string): string {
  const date = new Date(iso);
  return `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}`;
}

const points = (n: number) => `${Math.abs(Math.round(n))} ${Math.abs(Math.round(n)) === 1 ? 'point' : 'points'}`;

/** The pace in a few words: "12 points ahead of pace", "On pace", "8 points under the line". */
export function paceText(pace: RunRatePace): string {
  if (pace.ahead) return `${points(pace.points)} ahead of pace`;
  // Over the line by less than RUN_RATE_AHEAD_POINTS is still on pace: a point is rounding.
  if (Math.round(pace.points) >= 0) return 'On pace';
  return `${points(pace.points)} under the line`;
}

/** The line in a sentence: "The line for 80% by Fri 18:00 is at 61% now." */
export function lineText(pace: RunRatePace, target: RunRateTarget): string {
  if (pace.pastTarget) return `Past ${targetText(target)}, the line runs from ${target.percent}% to 100% at the reset: ${Math.round(pace.line)}% now.`;
  return `The line for ${target.percent}% by ${targetText(target)} is at ${Math.round(pace.line)}% now.`;
}

/** The projection in a sentence, or undefined when there's nothing to say yet. */
export function projectionText(projection: RunRateProjection | null): string | undefined {
  if (projection === null) return undefined;
  switch (projection.status) {
    case 'thin':
      return 'Not enough readings yet this week for a projection: it needs 6 hours of them, read while a pitwall page is open.';
    case 'used-up':
      return "The plan's week is used up until it resets.";
    case 'lasts':
      return 'At this rate, it lasts to the reset.';
    case 'range':
      return projection.latest === null
        ? `At this rate, 100% from ${dayTimeText(projection.earliest)}, or not before the reset.`
        : `At this rate, 100% between ${dayTimeText(projection.earliest)} and ${dayTimeText(projection.latest)}.`;
  }
}

/** Whether a reading at `readAt` is old enough that the page should say how old. */
export function showsAge(readAt: string, now: number): boolean {
  return now - Date.parse(readAt) > RUN_RATE_AGE_SHOWN_MS;
}

/** The week's figures, unless its week has reset since it was read. */
export function currentWeek(rate: RunRate | undefined, now: number): RunRateWeek | undefined {
  if (rate?.status !== 'available' || rate.sevenDay === null) return undefined;
  const resets = rate.sevenDay.resetsAt;
  return resets !== null && Date.parse(resets) <= now ? undefined : rate.sevenDay;
}

/** The five hours' figure, unless it's reset since, or older than its window could hold. */
export function currentFive(rate: RunRate | undefined, now: number): RunRateWindow | undefined {
  if (rate?.status !== 'available' || rate.fiveHour === null) return undefined;
  const resets = rate.fiveHour.resetsAt;
  return resets !== null && Date.parse(resets) <= now ? undefined : rate.fiveHour;
}

/** The header button's tooltip: what the figures mean, the pace and the projection. */
export function meterHint(rate: RunRate & { status: 'available' }, week: RunRateWeek | undefined, five: RunRateWindow | undefined): string {
  const parts: string[] = [];
  if (week !== undefined) {
    parts.push(`The plan's week: ${Math.round(week.usedPercentage)}% used${week.resetsAt === null ? '' : `, resets ${resetText(week.resetsAt)}`}.`);
    if (week.pace !== null) parts.push(`${paceText(week.pace)}. ${lineText(week.pace, rate.target)}`);
    const projected = projectionText(week.projection);
    if (projected !== undefined) parts.push(projected);
  }
  if (five !== undefined) parts.push(`The five hours: ${Math.round(five.usedPercentage)}% used${five.resetsAt === null ? '' : `, resets ${dayTimeText(five.resetsAt)}`}.`);
  if (rate.fallback !== undefined) parts.push("pitwall's latest read of these failed, so they're from the one before.");
  return parts.join(' ');
}
