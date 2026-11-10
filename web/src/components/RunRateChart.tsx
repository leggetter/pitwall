// The run rate as a chart (W181, docs/design-system.md, 4: Usage), in the Usage view's This week:
// the week's readings, the trend, the reserve's line and 100%, drawn by hand as SVG with the design
// system's tokens. The layout and the words are web/src/runRateChart.ts'. It's an image with a full
// description; the sentences beside it (the pace, PaceFigure in UsageDialog.tsx) say the same.

import { useLayoutEffect, useRef, useState } from 'react';
import type { RunRate, RunRateChart as Chart } from '../../../src/shared/protocol.js';
import { chartDescription, layoutChart, type ChartInput, type ChartLabel } from '../runRateChart.js';

export interface RunRateChartProps {
  chart: Chart;
  rate: RunRate & { status: 'available' };
  stale: boolean;
  now: number;
}

/** Before the first measure, as in a test's DOM, which has no layout. */
const FALLBACK_WIDTH = 560;

/** The element's width, kept up to date. */
function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const measure = () => {
      const measured = Math.floor(element.getBoundingClientRect().width);
      if (measured > 0) setWidth(measured);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function Label({ label, className }: { label: ChartLabel; className: string }) {
  return (
    <text className={className} x={label.x} y={label.y} textAnchor={label.anchor}>
      {label.text}
    </text>
  );
}

export function RunRateChart({ chart, rate, stale, now }: RunRateChartProps) {
  const [ref, width] = useWidth();
  const input: ChartInput = { chart, target: rate.target, pace: rate.sevenDay?.pace ?? null, stale, now, thin: rate.sevenDay?.projection?.status === 'thin' };
  const layout = layoutChart(input, width);
  const { plot } = layout;
  return (
    <div className="rr-chart" ref={ref} data-compact={layout.compact || undefined} data-stale={stale || undefined}>
      <svg role="img" aria-label={chartDescription(input)} width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`}>
        <g aria-hidden="true">
          {layout.days.map((day) => (
            <line key={day.x} className="rr-grid" x1={day.x} x2={day.x} y1={plot.top} y2={plot.bottom} />
          ))}
          {layout.yTicks.map((tick) => (
            <g key={tick.label}>
              {!tick.limit && <line className="rr-grid" x1={plot.left} x2={plot.right} y1={tick.y} y2={tick.y} />}
              <text className={tick.limit ? 'rr-tick rr-tick-limit' : 'rr-tick'} x={plot.left - 6} y={tick.y + 4} textAnchor="end">
                {tick.label}
              </text>
            </g>
          ))}
          {layout.dayLabels.map((day) => (
            <text key={day.x} className="rr-tick" x={day.x} y={plot.bottom + 16} textAnchor="middle">
              {day.label}
            </text>
          ))}
          {layout.trend && <path className="rr-band" d={layout.trend.band} />}
          {/* 100%: the limit, solid and labelled, over the band. */}
          <line className="rr-limit" x1={plot.left} x2={plot.right} y1={layout.yTicks[2]!.y} y2={layout.yTicks[2]!.y} />
          <path className="rr-target" d={layout.line} />
          {layout.target && (
            <>
              <circle className="rr-target-dot" cx={layout.target.x} cy={layout.target.y} r={4} />
              {layout.target.label && <Label label={layout.target.label} className="rr-label" />}
            </>
          )}
          {layout.now && (
            <>
              <line className="rr-now" x1={layout.now.x} x2={layout.now.x} y1={plot.top - 4} y2={plot.bottom} />
              <Label label={layout.now.label} className="rr-label rr-label-strong" />
            </>
          )}
          {layout.age && <Label label={layout.age} className="rr-label rr-label-strong" />}
          {layout.note && <Label label={layout.note} className="rr-label" />}
          {layout.trend && <path className="rr-trend" d={layout.trend.mid} />}
          {layout.trend?.marks.map((mark) => (
            <circle key={mark.x} className="rr-limit-dot" cx={mark.x} cy={mark.y} r={4} />
          ))}
          {layout.trend?.label && <Label label={layout.trend.label} className="rr-label" />}
          {layout.crossing && (
            <>
              <circle className="rr-target-dot" cx={layout.crossing.x} cy={layout.crossing.y} r={4} />
              {layout.crossing.label && <Label label={layout.crossing.label} className="rr-label" />}
            </>
          )}
          {layout.gap && (
            <>
              <line className="rr-gap" x1={layout.gap.x} x2={layout.gap.x} y1={layout.gap.y1} y2={layout.gap.y2} />
              <line className="rr-gap" x1={layout.gap.x - 3} x2={layout.gap.x + 3} y1={layout.gap.y1} y2={layout.gap.y1} />
              <line className="rr-gap" x1={layout.gap.x - 3} x2={layout.gap.x + 3} y1={layout.gap.y2} y2={layout.gap.y2} />
              {layout.gap.label && <Label label={layout.gap.label} className="rr-label" />}
            </>
          )}
          {layout.readings.map((d) => (
            <path key={d} className="rr-readings" d={d} />
          ))}
          {layout.lone.map((dot) => (
            <circle key={`${dot.x},${dot.y}`} className="rr-reading-dot" cx={dot.x} cy={dot.y} r={2.5} />
          ))}
          <circle className="rr-last" cx={layout.last.x} cy={layout.last.y} r={4} />
        </g>
      </svg>
    </div>
  );
}
