// The run rate as a chart (W181, docs/design-system.md, 4: Usage): the plan's week from its start to
// its reset, left to right, and the percentage used from bottom to top. The server's numbers
// (RunRateChart, worked out by src/usage/runRate.ts from the same reading as the pace) read
// defensively, laid out for a width, and said in words for the chart's accessible name.
//
// - The readings: a solid line, broken where readings are more than RUN_RATE_CHART_GAP_MS apart, as
//   across a night with no page open, so a gap is never drawn as steady use.
// - The trend: from the reading, the projection's range as a band and its middle as a dashed line,
//   only with the projection's rates and a fresh reading.
// - The line: the reserve's, dashed, as the pace's: from 0 at the start to the target at its time,
//   then on to 100 at the reset, since the pace's sentences ("Past Fri 18:00, the line runs from 80%
//   to 100% at the reset") measure against that part too.
// - 100%, labelled; "now"; where the trend reaches 100%; where its middle crosses the line.
//
// Never a stale chart as current: a reading over RUN_RATE_AGE_SHOWN_MS old, or one standing in for a
// failed read, draws the readings and the lines with the reading's age, and no "now" and no trend.

import { RUN_RATE_CHART_GAP_MS, RUN_RATE_CHART_POINTS, type RunRateChart, type RunRateChartPoint, type RunRatePace, type RunRateTarget } from '../../src/shared/protocol.js';
import { relativeTime } from './format.js';
import { dayTimeText, paceText, targetText } from './runRate.js';

// --- Reading the answer ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const isPercent = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1000;
const isPoint = (value: unknown): value is RunRateChartPoint => isRecord(value) && isTime(value.at) && isPercent(value.percent);
const isPoints = (value: unknown, max: number): value is RunRateChartPoint[] => Array.isArray(value) && value.length <= max && value.every(isPoint);

/** The server's chart, when it has the shape this page draws; undefined otherwise, so no chart. */
export function asRunRateChart(value: unknown): RunRateChart | undefined {
  if (!isRecord(value) || !isTime(value.start) || !isTime(value.end) || !isTime(value.at) || !(value.start < value.end)) return undefined;
  if (!isPoints(value.readings, RUN_RATE_CHART_POINTS) || value.readings.length === 0 || !isPoints(value.line, 3) || value.line.length < 2) return undefined;
  const trend = value.trend;
  if (trend !== null && !(isRecord(trend) && isPoint(trend.low) && isPoint(trend.mid) && isPoint(trend.high))) return undefined;
  const cross = value.crossesLine;
  if (cross !== null && !(isRecord(cross) && isTime(cross.at) && (cross.to === 'over' || cross.to === 'under'))) return undefined;
  return value as unknown as RunRateChart;
}

// --- Layout ---------------------------------------------------------------------------------------

/** Below this width the chart drops its secondary labels: the sentences beside it keep them. */
export const COMPACT_WIDTH = 480;
const MARGIN = { top: 28, right: 12, bottom: 24, left: 44 };
const PLOT_HEIGHT = { wide: 184, compact: 156 };
/** About how wide a character of 12 px Inter is, to keep labels apart and inside the box. */
const CHAR_PX = 6.6;
/** A connector under this tall gets no label: the sentence says "On pace". */
const GAP_LABEL_MIN_PX = 10;

export interface ChartLabel {
  x: number;
  y: number;
  text: string;
  anchor: 'start' | 'middle' | 'end';
}

export interface ChartLayout {
  width: number;
  height: number;
  compact: boolean;
  plot: { left: number; right: number; top: number; bottom: number };
  /** Horizontal gridlines and their ticks: 0, 50 and 100%, 100% drawn as the limit. */
  yTicks: Array<{ y: number; label: string; limit: boolean }>;
  /** A hairline at each local midnight, and each day's short name in the middle of its part. */
  days: Array<{ x: number }>;
  dayLabels: Array<{ x: number; label: string }>;
  /** The readings, one path per run of joined readings, and dots for lone ones. */
  readings: string[];
  lone: Array<{ x: number; y: number }>;
  /** The reading itself. */
  last: { x: number; y: number };
  line: string;
  target: { x: number; y: number; label: ChartLabel | undefined } | undefined;
  /** Only with a fresh reading. */
  now: { x: number; label: ChartLabel } | undefined;
  /** Between the reading and the line at its time: the pace's "14 points under the line". */
  gap: { x: number; y1: number; y2: number; label: ChartLabel | undefined } | undefined;
  /** Only with a fresh reading and the projection's rates. */
  trend: { band: string; mid: string; marks: Array<{ x: number; y: number }>; label: ChartLabel | undefined } | undefined;
  crossing: { x: number; y: number; label: ChartLabel | undefined } | undefined;
  /** The reading's age, where "now" would be, for a stale one. */
  age: ChartLabel | undefined;
  /** Why there's no trend, where it would be: too few readings yet. */
  note: ChartLabel | undefined;
}

export interface ChartInput {
  chart: RunRateChart;
  target: RunRateTarget;
  pace: RunRatePace | null;
  /** The reading is over RUN_RATE_AGE_SHOWN_MS old, or stands in for a failed read. */
  stale: boolean;
  /** For the reading's age. */
  now: number;
  /** The projection is 'thin': too few readings for a trend yet. */
  thin: boolean;
}

const round = (n: number) => Math.round(n * 10) / 10;

/** The week's local midnights after `start` and before `end`. */
function midnights(start: number, end: number): number[] {
  const out: number[] = [];
  const day = new Date(start);
  day.setHours(0, 0, 0, 0);
  for (let i = 0; i < 9; i++) {
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate() + i + 1).getTime();
    if (at >= end) break;
    if (at > start) out.push(at);
  }
  return out;
}

/** Keeps a label of `text` inside the plot's width, anchored as asked where it fits. */
function fit(x: number, y: number, text: string, anchor: ChartLabel['anchor'], left: number, right: number): ChartLabel {
  const width = text.length * CHAR_PX;
  const from = anchor === 'start' ? x : anchor === 'end' ? x - width : x - width / 2;
  if (from < left) return { x: left, y, text, anchor: 'start' };
  if (from + width > right) return { x: right, y, text, anchor: 'end' };
  return { x, y, text, anchor };
}

const extent = (label: ChartLabel) => {
  const width = label.text.length * CHAR_PX;
  const from = label.anchor === 'start' ? label.x : label.anchor === 'end' ? label.x - width : label.x - width / 2;
  return [from, from + width] as const;
};
const overlaps = (a: ChartLabel, b: ChartLabel) => {
  const [a0, a1] = extent(a);
  const [b0, b1] = extent(b);
  return Math.abs(a.y - b.y) < 14 && a0 < b1 + 6 && b0 < a1 + 6;
};

/** The chart laid out for `width` px. */
export function layoutChart(input: ChartInput, width: number): ChartLayout {
  const { chart, target, pace, stale } = input;
  const compact = width < COMPACT_WIDTH;
  const plotHeight = compact ? PLOT_HEIGHT.compact : PLOT_HEIGHT.wide;
  const plot = { left: MARGIN.left, right: Math.max(MARGIN.left + 40, width - MARGIN.right), top: MARGIN.top, bottom: MARGIN.top + plotHeight };
  const most = Math.max(100, ...chart.readings.map((p) => p.percent));
  const yMax = most > 100 ? Math.ceil(most / 10) * 10 : 100;
  const x = (at: number) => round(plot.left + ((Math.min(Math.max(at, chart.start), chart.end) - chart.start) / (chart.end - chart.start)) * (plot.right - plot.left));
  const y = (percent: number) => round(plot.bottom - (Math.min(Math.max(percent, 0), yMax) / yMax) * (plot.bottom - plot.top));
  const pt = (p: RunRateChartPoint) => `${x(p.at)},${y(p.percent)}`;

  const yTicks = [0, 50, 100].map((percent) => ({ y: y(percent), label: `${percent}%`, limit: percent === 100 }));
  const nights = midnights(chart.start, chart.end);
  const days = nights.map((at) => ({ x: x(at) }));
  const edges = [chart.start, ...nights, chart.end];
  const dayLabels: ChartLayout['dayLabels'] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const from = edges[i]!;
    const to = edges[i + 1]!;
    // A part of a day under 8 hours, as a reset's at noon, has no room for its name; narrow, no part of one has.
    if (to - from < (compact ? 23 : 8) * 3_600_000) continue;
    dayLabels.push({ x: x((from + to) / 2), label: new Date((from + to) / 2).toLocaleDateString(undefined, { weekday: 'short' }) });
  }

  // The readings, broken at gaps.
  const runs: RunRateChartPoint[][] = [];
  for (const point of chart.readings) {
    const run = runs.at(-1);
    if (run !== undefined && point.at - run.at(-1)!.at <= RUN_RATE_CHART_GAP_MS) run.push(point);
    else runs.push([point]);
  }
  const readings = runs.filter((run) => run.length > 1).map((run) => `M${run.map(pt).join('L')}`);
  const lone = runs.filter((run) => run.length === 1).map(([p]) => ({ x: x(p!.at), y: y(p!.percent) }));
  const reading = chart.readings.at(-1)!;
  const last = { x: x(reading.at), y: y(reading.percent) };

  const line = `M${chart.line.map(pt).join('L')}`;
  const targetPoint = chart.line.length === 3 ? chart.line[1] : undefined;
  const target_: ChartLayout['target'] = targetPoint && {
    x: x(targetPoint.at),
    y: y(targetPoint.percent),
    // Above and left of its point, unless the reading is over the line, when the trend runs there:
    // then below and right, where nothing does.
    label:
      reading.percent > lineAt(chart, reading.at) && !stale
        ? fit(x(targetPoint.at) + 8, y(targetPoint.percent) + 18, compact ? `${target.percent}% ${targetText(target)}` : `${target.percent}% by ${targetText(target)}`, 'start', plot.left, plot.right)
        : fit(x(targetPoint.at) - 8, y(targetPoint.percent) - 8, compact ? `${target.percent}% ${targetText(target)}` : `${target.percent}% by ${targetText(target)}`, 'end', plot.left, plot.right),
  };

  // Top labels, in the margin above 100%: "now", then the trend's 100%, kept apart.
  const topY = plot.top - 10;
  const nowLabel = stale ? undefined : fit(last.x, topY, `Now ${Math.round(reading.percent)}%`, 'middle', plot.left, plot.right);
  const now = nowLabel && { x: last.x, label: nowLabel };
  const age = stale ? fit(last.x, topY, `${Math.round(reading.percent)}%, ${relativeTime(new Date(reading.at).toISOString(), input.now)}`, 'middle', plot.left, plot.right) : undefined;

  let gap: ChartLayout['gap'];
  if (!stale && pace !== null) {
    const lineY = y(pace.line);
    const tall = Math.abs(lineY - last.y);
    const words = paceText(pace);
    const short = words.replace(/ the line$| of pace$/, '');
    gap = {
      x: last.x,
      y1: Math.min(lineY, last.y),
      y2: Math.max(lineY, last.y),
      // Where neither line runs: under the line, below and right of the reading, where the trend rises
      // away above it; over it, right of the connector's middle, under the trend and over the line.
      label:
        tall < GAP_LABEL_MIN_PX || words === 'On pace'
          ? undefined
          : last.y > lineY
            ? fit(last.x + 8, Math.min(plot.bottom - 4, last.y + 18), compact ? short : words, 'start', plot.left, plot.right)
            : fit(last.x + 8, round((lineY + last.y) / 2 + 4), compact ? short : words, 'start', plot.left, plot.right),
    };
  }

  let trend: ChartLayout['trend'];
  let crossing: ChartLayout['crossing'];
  if (!stale && chart.trend !== null) {
    const { low, mid, high } = chart.trend;
    const from = `${x(reading.at)},${y(reading.percent)}`;
    const band = [from, pt(high)];
    if (high.percent >= 100 && high.at < chart.end) band.push(low.percent >= 100 ? pt({ at: low.at, percent: 100 }) : pt({ at: chart.end, percent: 100 }));
    if (!(low.percent >= 100)) band.push(pt(low));
    const marks = [high, low].filter((p) => p.percent >= 100 && p.at < chart.end).map((p) => ({ x: x(p.at), y: y(100) }));
    let label: ChartLabel | undefined;
    if (high.percent >= 100 && high.at < chart.end) {
      const early = dayTimeText(new Date(high.at).toISOString());
      const late = low.percent >= 100 && low.at < chart.end ? dayTimeText(new Date(low.at).toISOString()) : undefined;
      const text = late === undefined ? `100% from ${early}` : `100% ${early} to ${late}`;
      const centre = late === undefined ? x(high.at) : (x(high.at) + x(low.at)) / 2;
      label = fit(centre, topY, text, late === undefined ? 'start' : 'middle', plot.left, plot.right);
      // Kept clear of "Now": moved to its right, or dropped where there's no room (the sentence has it).
      if (nowLabel !== undefined && overlaps(label, nowLabel)) {
        const moved = fit(extent(nowLabel)[1] + 12, topY, text, 'start', plot.left, plot.right);
        label = overlaps(moved, nowLabel) ? undefined : moved;
      }
    }
    trend = { band: `M${band.join('L')}Z`, mid: `M${from}L${pt(mid)}`, marks, label };
    if (chart.crossesLine !== null) {
      const cx = x(chart.crossesLine.at);
      const cy = y(lineAt(chart, chart.crossesLine.at));
      const words = `${chart.crossesLine.to === 'over' ? 'Over' : 'Under'} the line ${dayTimeText(new Date(chart.crossesLine.at).toISOString())}`;
      // Below the line when going over it, where the band isn't yet; above when going under.
      const ly = chart.crossesLine.to === 'over' ? cy + 18 : cy - 10;
      crossing = { x: cx, y: cy, label: compact ? undefined : fit(cx + 8, ly, words, 'start', plot.left, plot.right) };
    }
  }

  // Labels that would overlap give way, in this order: now or the age, the trend's 100%, the target,
  // the pace, the crossing. What's dropped is still in the sentences beside the chart.
  const kept: ChartLabel[] = [];
  const keep = (label: ChartLabel | undefined) => {
    if (label === undefined || kept.some((other) => overlaps(label, other))) return undefined;
    kept.push(label);
    return label;
  };
  keep(nowLabel ?? age);
  if (trend) trend.label = keep(trend.label);
  if (target_) target_.label = keep(target_.label);
  if (gap) gap.label = keep(gap.label);
  if (crossing) crossing.label = keep(crossing.label);
  const note =
    !stale && chart.trend === null && input.thin
      ? // Low and right of now, where the trend would start and nothing else is drawn.
        keep(fit(last.x + 10, plot.bottom - 8, compact ? 'No trend yet' : 'No trend yet: too few readings', 'start', plot.left, plot.right))
      : undefined;
  return { width, height: plot.bottom + MARGIN.bottom, compact, plot, yTicks, days, dayLabels, readings, lone, last, line, target: target_, now, gap, trend, crossing, age, note };
}

/** The line at `at`, from its points. */
export function lineAt(chart: RunRateChart, at: number): number {
  const points = chart.line;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (at <= b.at) return b.at === a.at ? b.percent : a.percent + ((b.percent - a.percent) * (at - a.at)) / (b.at - a.at);
  }
  return points.at(-1)!.percent;
}

// --- Words ----------------------------------------------------------------------------------------

/** The crossing in a sentence, or undefined without one: "At the trend's middle, over the line from Wed 10:00." */
export function crossingText(chart: RunRateChart, stale: boolean): string | undefined {
  if (stale || chart.trend === null || chart.crossesLine === null) return undefined;
  const when = dayTimeText(new Date(chart.crossesLine.at).toISOString());
  return chart.crossesLine.to === 'over' ? `At the middle of that range, it goes over the line from ${when}.` : `At the middle of that range, it's back under the line from ${when}.`;
}

/** The chart in words, for its accessible name: everything it draws, as the sentences beside it say it. */
export function chartDescription(input: ChartInput): string {
  const { chart, target, pace, stale } = input;
  const reading = chart.readings.at(-1)!;
  const iso = (ms: number) => new Date(ms).toISOString();
  const parts = [
    `A chart of the plan's week, from ${dayTimeText(iso(chart.start))} to ${dayTimeText(iso(chart.end))}: the percentage used, from ${chart.readings.length} ${chart.readings.length === 1 ? 'reading' : 'readings'}.`,
    stale
      ? `The latest reading, ${relativeTime(iso(reading.at), input.now)}, was ${Math.round(reading.percent)}%; no trend is drawn from it.`
      : `Now, ${dayTimeText(iso(reading.at))}, ${Math.round(reading.percent)}% used.`,
    `The dashed line for ${target.percent}% by ${targetText(target)} runs from 0 at the start to ${target.percent}% at ${targetText(target)}, then to 100% at the reset.`,
  ];
  if (!stale && pace !== null) parts.push(`${paceText(pace)}: the line is at ${Math.round(pace.line)}% now.`);
  if (!stale && chart.trend !== null) {
    const { low, high } = chart.trend;
    const reaches = (p: RunRateChartPoint) => (p.percent >= 100 && p.at < chart.end ? `100% at ${dayTimeText(iso(p.at))}` : `${Math.round(p.percent)}% at the reset`);
    parts.push(`The trend, a band from the reading, reaches ${reaches(high)} at the faster rate and ${reaches(low)} at the slower.`);
    const crossed = crossingText(chart, stale);
    if (crossed !== undefined) parts.push(crossed);
  } else if (!stale && input.thin) parts.push('No trend yet: not enough readings this week.');
  return parts.join(' ');
}
