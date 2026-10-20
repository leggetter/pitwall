// A relative time (docs/design-system.md, 4: Timestamps): "just now", "42s ago", "5m ago", "3h ago",
// "2d ago", or the header's "updated 7s ago", which counts in seconds below a minute. A <time> with
// the instant in `datetime`, and the absolute time, in the user's locale with seconds, in a tooltip.
// It ticks on the shared clock (clock.ts), one interval for the whole page, and it's never in a live
// region, so the ticking isn't announced.

import { useNow } from '../clock.js';
import { absoluteTime, relativeTime, updatedAgo } from '../format.js';
import { Tooltip } from './Tooltip.js';

export interface TimestampProps {
  /** An ISO time. */
  at: string;
  /** `relative` ("5m ago"), or `updated` ("updated 7s ago"), for the header. */
  format?: 'relative' | 'updated';
  /** Text before the time, such as "Active ". */
  prefix?: string;
  className?: string;
}

export function Timestamp({ at, format = 'relative', prefix, className }: TimestampProps) {
  const now = useNow();
  const text = format === 'updated' ? updatedAgo(at, now) : relativeTime(at, now);
  return (
    <Tooltip content={absoluteTime(at)} relation="none">
      <time className={className} dateTime={at}>
        {prefix}
        {text}
      </time>
    </Tooltip>
  );
}
