// The header's Usage button (W158), with the run rate on it (W159, docs/design-system.md, 4: Usage).
//
// - Without figures (off with `--no-usage`, before the first answer, or the read unavailable): the
//   ghost `usage` icon button, named "Usage", as W158 made it. The Usage view says why.
// - With them: a ghost button with the icon, "Week 45%", and "5h 30%" only when the server sends a
//   five-hour window (spike 013 saw none on Phil's plan). Each figure is a subtle badge in its level's
//   tone, neutral, warning from 70% and danger from 90%; the number says it too, never the colour alone.
//   "Ahead of pace", a subtle warning badge, while the week is over the reserve's line. Its name is its
//   text, after a visually hidden "Usage:", so what's on screen is in its name. Its tooltip, a
//   description, has the pace and the projection in sentences; the Usage view has them too, for touch.
// - At 600 px and narrower, the week's figure alone shows, so the header doesn't gain a row: the five
//   hours, Ahead of pace and the age stay in the name and the tooltip, and ahead of pace puts a
//   warning icon in the week's badge, so it's never the colour alone.
// - A figure older than RUN_RATE_AGE_SHOWN_MS says how old, as "14m ago", and one whose window has
//   reset since isn't shown.

import type { RunRate } from '../../../src/shared/protocol.js';
import { useNow } from '../clock.js';
import { relativeTime } from '../format.js';
import { currentFive, currentWeek, meterHint, showsAge } from '../runRate.js';
import { USAGE_LABEL } from '../usage.js';
import { Button } from './Button.js';
import { Icon } from './Icon.js';
import { Tooltip } from './Tooltip.js';
import './Usage.css';

export interface UsageButtonProps {
  onUsage: () => void;
  /** The run rate, while the page asks for it (useRunRate()). */
  runRate?: RunRate | undefined;
}

const LEVEL_LOOK = { normal: 'badge-subtle-neutral', amber: 'badge-subtle-warning', red: 'badge-subtle-danger' } as const;

export function UsageButton({ onUsage, runRate }: UsageButtonProps) {
  // Only a button with figures ticks on the shared clock, for their age and their window's reset.
  if (runRate?.status === 'available') return <UsageMeter onUsage={onUsage} runRate={runRate} />;
  return <UsageIcon onUsage={onUsage} />;
}

function UsageIcon({ onUsage }: { onUsage: () => void }) {
  return (
    <Tooltip content={USAGE_LABEL} relation="label">
      <button type="button" className="icon-button ghost md usage-button" aria-haspopup="dialog" onClick={onUsage}>
        <Icon name="usage" />
      </button>
    </Tooltip>
  );
}

function UsageMeter({ onUsage, runRate }: { onUsage: () => void; runRate: RunRate & { status: 'available' } }) {
  const now = useNow();
  const week = currentWeek(runRate, now);
  const five = currentFive(runRate, now);
  if (week === undefined && five === undefined) return <UsageIcon onUsage={onUsage} />;
  const old = runRate.fallback !== undefined || showsAge(runRate.readAt, now);
  const ahead = week?.pace?.ahead === true;
  return (
    <Tooltip content={meterHint(runRate, week, five)} relation="description">
      <Button variant="ghost" icon="usage" className="usage-button usage-meter" aria-haspopup="dialog" onClick={onUsage}>
        <span className="visually-hidden">{USAGE_LABEL}: </span>
        {week !== undefined && (
          <span className={`badge ${LEVEL_LOOK[week.level]} usage-meter-figure`} data-level={week.level}>
            {/* At 600 px and narrower, where "Ahead of pace" is only in the name, this icon says it on screen. */}
            {ahead && <Icon name="warning" className="usage-meter-ahead-icon" />}
            Week {Math.round(week.usedPercentage)}%
          </span>
        )}
        {/* The rest is in the name and the tooltip at any width, and on screen above 600 px (Usage.css). */}
        {five !== undefined && (
          <span className={`badge ${LEVEL_LOOK[five.level]} usage-meter-figure usage-meter-wide`} data-level={five.level}>
            5h {Math.round(five.usedPercentage)}%
          </span>
        )}
        {ahead && <span className="badge badge-subtle-warning usage-meter-ahead usage-meter-wide">Ahead of pace</span>}
        {old && <span className="usage-meter-age usage-meter-wide">{relativeTime(runRate.readAt, now)}</span>}
      </Button>
    </Tooltip>
  );
}
