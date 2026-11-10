// The run rate as a chart (W181): reading the server's chart, its layout (readings broken at gaps, the
// trend only from a fresh reading, the labels inside the box, a simpler chart when narrow), its words,
// and its place in the Usage view's This week, beside the pace's sentences. Made-up figures only.

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RUN_RATE_CHART_POINTS, type RunRate, type RunRateChart as Chart, type RunRateWeek, type UsageView } from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import { asRunRateChart, chartDescription, crossingText, layoutChart, type ChartInput } from '../runRateChart.js';
import { UsageDialog } from './UsageDialog.js';

const HOUR = 3_600_000;
/** A week that started 3 days ago at noon, read a minute ago, so "now" is fresh whenever the test runs. */
const NOW = Date.now();
const READ_AT = NOW - 60_000;
const START = READ_AT - 72 * HOUR;
const END = START + 168 * HOUR;
const TARGET_AT = START + 126 * HOUR;
const TARGET = { percent: 80, day: 'friday', time: '18:00' } as const;

/** Every 5 minutes for the 12 hours before the reading, and 8 hours the day before: one gap. */
function readings(): Chart['readings'] {
  const out: Chart['readings'] = [];
  for (let at = START + 40 * HOUR; at <= START + 48 * HOUR; at += 30 * 60_000) out.push({ at, percent: Math.round((at - START) / HOUR / 2) });
  for (let at = START + 60 * HOUR; at <= READ_AT; at += 30 * 60_000) out.push({ at, percent: Math.round((at - START) / HOUR / 2) });
  if (out.at(-1)!.at !== READ_AT) out.push({ at: READ_AT, percent: 36 });
  return out;
}

function chart(extra: Partial<Chart> = {}): Chart {
  return {
    start: START,
    end: END,
    at: READ_AT,
    readings: readings(),
    line: [
      { at: START, percent: 0 },
      { at: TARGET_AT, percent: 80 },
      { at: END, percent: 100 },
    ],
    trend: { low: { at: END, percent: 84 }, mid: { at: END - 10 * HOUR, percent: 100 }, high: { at: END - 30 * HOUR, percent: 100 } },
    crossesLine: { at: START + 100 * HOUR, to: 'over' },
    ...extra,
  };
}

function week(extra: Partial<RunRateWeek> = {}): RunRateWeek {
  return {
    usedPercentage: 36,
    resetsAt: new Date(END).toISOString(),
    level: 'normal',
    pace: { targetAt: new Date(TARGET_AT).toISOString(), line: 45.7, points: -9.7, ahead: false, pastTarget: false },
    projection: { status: 'range', earliest: new Date(END - 30 * HOUR).toISOString(), latest: null, perHour: { low: 0.5, high: 0.7 } },
    ...extra,
  };
}

function rate(extra: Partial<RunRate & { status: 'available' }> = {}): RunRate & { status: 'available' } {
  return { status: 'available', readAt: new Date(READ_AT).toISOString(), target: TARGET, sevenDay: week(), fiveHour: null, ...extra };
}

/** The made-up chart's line at `at`, in percent. */
const lineAtPx = (at: number) => (at <= TARGET_AT ? (80 * (at - START)) / (TARGET_AT - START) : 80 + (20 * (at - TARGET_AT)) / (END - TARGET_AT));

const input = (extra: Partial<ChartInput> = {}): ChartInput => ({ chart: chart(), target: TARGET, pace: week().pace, stale: false, now: NOW, thin: false, ...extra });

describe('reading the chart', () => {
  it('takes the server’s shape, and refuses anything else', () => {
    expect(asRunRateChart(chart())).toEqual(chart());
    expect(asRunRateChart(chart({ trend: null, crossesLine: null }))).toBeDefined();
    expect(asRunRateChart(undefined)).toBeUndefined();
    expect(asRunRateChart({ ...chart(), start: END })).toBeUndefined();
    expect(asRunRateChart(chart({ readings: [] }))).toBeUndefined();
    expect(asRunRateChart(chart({ readings: [{ at: READ_AT, percent: '36' as never }] }))).toBeUndefined();
    expect(asRunRateChart(chart({ readings: Array.from({ length: RUN_RATE_CHART_POINTS + 1 }, (_, i) => ({ at: START + i, percent: 1 })) }))).toBeUndefined();
    expect(asRunRateChart(chart({ crossesLine: { at: READ_AT, to: 'sideways' as never } }))).toBeUndefined();
    expect(asRunRateChart(chart({ trend: { low: { at: 1, percent: 1 } } as never }))).toBeUndefined();
  });
});

describe('its layout', () => {
  it('breaks the readings at a gap, ends at the reading, and keeps every label inside the box', () => {
    const layout = layoutChart(input(), 640);
    expect(layout.compact).toBe(false);
    expect(layout.readings).toHaveLength(2);
    expect(layout.yTicks.map((tick) => [tick.label, tick.limit])).toEqual([
      ['0%', false],
      ['50%', false],
      ['100%', true],
    ]);
    expect(layout.dayLabels.length).toBeGreaterThanOrEqual(6);
    expect(layout.now?.label.text).toBe('Now 36%');
    expect(layout.target?.label?.text).toBe('80% by Fri 18:00');
    expect(layout.gap?.label?.text).toBe('10 points under the line');
    expect(layout.trend?.marks).toHaveLength(1);
    expect(layout.trend?.label?.text).toMatch(/^100% from \S+ \d\d:\d\d$/);
    expect(layout.crossing?.label?.text).toMatch(/^Over the line \S+ \d\d:\d\d$/);
    for (const label of [layout.now!.label, layout.target!.label!, layout.gap!.label!, layout.trend!.label!, layout.crossing!.label!]) {
      const width = label.text.length * 6.6;
      const from = label.anchor === 'start' ? label.x : label.anchor === 'end' ? label.x - width : label.x - width / 2;
      expect(from).toBeGreaterThanOrEqual(layout.plot.left - 0.5);
      expect(from + width).toBeLessThanOrEqual(layout.plot.right + 0.5);
    }
  });

  it('draws the band between the two ends: to both 100% marks when both reach it', () => {
    const both = layoutChart(input({ chart: chart({ trend: { low: { at: END - 5 * HOUR, percent: 100 }, mid: { at: END - 15 * HOUR, percent: 100 }, high: { at: END - 30 * HOUR, percent: 100 } } }) }), 640);
    expect(both.trend?.marks).toHaveLength(2);
    expect(both.trend?.label?.text).toMatch(/^100% \S+ \d\d:\d\d to \S+ \d\d:\d\d$/);
    const lasts = layoutChart(input({ chart: chart({ trend: { low: { at: END, percent: 60 }, mid: { at: END, percent: 70 }, high: { at: END, percent: 80 } } }) }), 640);
    expect(lasts.trend?.marks).toHaveLength(0);
    expect(lasts.trend?.label).toBeUndefined();
    // The "or not": how far it gets by the reset, at both rates when they differ.
    expect(lasts.trend?.end?.text).toBe('~60–80% at reset');
    // The faster reaches 100%, the slower doesn't: the slower's end.
    expect(layoutChart(input(), 900).trend?.end?.text).toBe('~84% at reset');
    expect(both.trend?.end).toBeUndefined();
  });

  it('puts the pace’s and the target’s labels where the line doesn’t run', () => {
    // Over the line: the label goes on the open side, not across the dashed line under the reading.
    const ahead = layoutChart(input({ pace: { ...week().pace!, line: 25, points: 11, ahead: true } }), 640);
    const label = ahead.gap!.label!;
    const lineY = ahead.plot.bottom - (lineAtPx(READ_AT) / 100) * (ahead.plot.bottom - ahead.plot.top);
    expect(label.text).toBe('11 points ahead of pace');
    expect(lineY < label.y - 11 || lineY > label.y + 3).toBe(true);
  });

  it('a stale reading: the readings and the lines with its age, no now, no trend, no crossing', () => {
    const layout = layoutChart(input({ stale: true, now: READ_AT + 2 * HOUR }), 640);
    expect(layout.now).toBeUndefined();
    expect(layout.trend).toBeUndefined();
    expect(layout.crossing).toBeUndefined();
    expect(layout.gap).toBeUndefined();
    expect(layout.age?.text).toBe('36%, 2h ago');
    expect(layout.readings).toHaveLength(2);
  });

  it('thin: no trend, and says why where it would be', () => {
    const layout = layoutChart(input({ chart: chart({ trend: null, crossesLine: null }), thin: true }), 640);
    expect(layout.trend).toBeUndefined();
    expect(layout.note?.text).toBe('No trend yet: too few readings');
  });

  it('narrow: shorter labels, and the crossing’s left to the sentence', () => {
    const layout = layoutChart(input(), 320);
    expect(layout.compact).toBe(true);
    expect(layout.target?.label?.text).toBe('80% Fri 18:00');
    expect(layout.gap?.label?.text).toBe('10 points under');
    expect(layout.crossing?.label).toBeUndefined();
    expect(layout.crossing).toBeDefined();
  });

  it('past 100%: the scale grows to fit, its ticks still 0, 50 and 100%', () => {
    const layout = layoutChart(input({ chart: chart({ readings: [...readings().slice(0, -1), { at: READ_AT, percent: 112 }], trend: null, crossesLine: null }) }), 640);
    expect(layout.yTicks.map((tick) => tick.label)).toEqual(['0%', '50%', '100%']);
    expect(layout.yTicks[2]!.y).toBeGreaterThan(layout.plot.top);
    expect(layout.last.y).toBeGreaterThanOrEqual(layout.plot.top);
  });
});

describe('its words', () => {
  it('describes everything it draws, and the crossing in a sentence', () => {
    const text = chartDescription(input());
    expect(text).toMatch(/^A chart of the plan's week, from \S+ \d\d:\d\d to \S+ \d\d:\d\d: the percentage used, from \d+ readings\./);
    expect(text).toContain('36% used.');
    expect(text).toContain('The dashed line for 80% by Fri 18:00 runs from 0 at the start to 80% at Fri 18:00, then to 100% at the reset.');
    expect(text).toContain('10 points under the line: the line is at 46% now.');
    expect(text).toMatch(/reaches 100% at \S+ \d\d:\d\d at the faster rate and 84% at the reset at the slower\./);
    expect(text).toMatch(/goes over the line from \S+ \d\d:\d\d\.$/);
    expect(crossingText(chart({ crossesLine: { at: START + 90 * HOUR, to: 'under' } }), false)).toMatch(/^At the middle rate, it's back under the line from/);
    expect(crossingText(chart(), true)).toBeUndefined();
    expect(chartDescription(input({ stale: true, now: READ_AT + 2 * HOUR }))).toContain('The latest reading, 2h ago, was 36%; no trend is drawn from it.');
    expect(chartDescription(input({ chart: chart({ trend: null, crossesLine: null }), thin: true }))).toContain('No trend yet: not enough readings this week.');
  });
});

describe('in the Usage view', () => {
  const zero = { calls: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0 };
  const tokens = { calls: 4, input: 10, cacheWrite: 20, cacheRead: 300, output: 5, cost: 1.5 };
  const VIEW = {
    window: { key: 'week', since: new Date(START).toISOString(), until: new Date(NOW).toISOString(), from: 'reset', bucket: 'day' },
    plan: { status: 'available', readAt: new Date(READ_AT).toISOString(), sevenDay: { usedPercentage: 36, resetsAt: new Date(END).toISOString() }, fiveHour: null },
    costLabel: 'API list price, a stand-in',
    totals: tokens,
    buckets: [{ start: new Date(START).toISOString(), ...tokens }],
    byRepo: { rows: [] },
    bySession: { rows: [] },
    byModel: [],
    split: { main: { sessions: 1, ...tokens }, subagent: { runs: 0, ...zero } },
    scan: { at: new Date(NOW).toISOString(), files: 1, unreadable: 0, malformed: 0 },
  } as unknown as UsageView;

  function dialog(view: UsageView) {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(view), { status: 200 }));
    render(
      <ApiContext.Provider value={createApiClient({ apiKey: 'k'.repeat(43), fetch })}>
        <UsageDialog onClose={() => {}} sessions={[]} />
      </ApiContext.Provider>,
    );
  }

  it('on This week: an image with a full description, the pace’s sentences beside it, not in the summary', async () => {
    dialog({ ...VIEW, runRate: rate(), runRateChart: chart() });
    const image = await screen.findByRole('img', { name: /^A chart of the plan's week/ });
    const section = image.closest('section')!;
    expect(within(section).getByRole('heading', { name: "The plan's week, at this rate" })).toBeTruthy();
    expect(within(section).getByText('Pace for 80% by Fri 18:00')).toBeTruthy();
    expect(section.querySelector('.usage-pace-value')?.textContent).toBe('10 points under the line');
    expect(within(section).getByText(/^At the middle rate, it goes over the line from/)).toBeTruthy();
    expect(document.querySelector('.usage-summary .usage-pace')).toBeNull();
    expect(image.querySelectorAll('.rr-readings')).toHaveLength(2);
    expect(image.querySelector('.rr-band')).not.toBeNull();
    expect(image.querySelector('.rr-trend')).not.toBeNull();
    expect(image.querySelector('.rr-limit')).not.toBeNull();
    expect(image.querySelector('.rr-now')).not.toBeNull();
    expect([...image.querySelectorAll('text')].map((t) => t.textContent)).toEqual(expect.arrayContaining(['100%', 'Now 36%', '80% by Fri 18:00']));
  });

  it('a stale reading: the readings with its age, no trend and no now', async () => {
    dialog({ ...VIEW, runRate: rate({ readAt: new Date(NOW - 2 * HOUR).toISOString(), fallback: { reason: 'timeout' } }), runRateChart: chart({ at: NOW - 2 * HOUR }) });
    const image = await screen.findByRole('img', { name: /no trend is drawn from it/ });
    expect(image.querySelector('.rr-band')).toBeNull();
    expect(image.querySelector('.rr-now')).toBeNull();
    expect(screen.getByText("From a reading 2h ago: pitwall's latest read of the plan's week failed.")).toBeTruthy();
  });

  it('no chart: without one, with a malformed one, or with the run rate unavailable; the pace back in the summary', async () => {
    dialog({ ...VIEW, runRate: rate(), runRateChart: { ...chart(), readings: 'many' } as never });
    expect(await screen.findByText('Pace for 80% by Fri 18:00')).toBeTruthy();
    expect(screen.queryByRole('img', { name: /^A chart/ })).toBeNull();
    expect(document.querySelector('.usage-summary .usage-pace')).not.toBeNull();
  });

  it('none with the run rate off, as with --no-usage', async () => {
    dialog({ ...VIEW, runRate: { status: 'off' }, runRateChart: chart() });
    expect(await screen.findByText('36% used')).toBeTruthy();
    expect(screen.queryByRole('img', { name: /^A chart/ })).toBeNull();
  });
});
