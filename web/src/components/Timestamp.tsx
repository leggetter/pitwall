// A time (docs/design-system.md, 4: Timestamps). Relative: "just now", "42s ago", "5m ago", "3h ago",
// "2d ago", or the header's "updated 7s ago", which counts in seconds below a minute. Or the time of
// day alone ("11:06"), for the conversation's speaker lines. A <time> with the instant in `datetime`,
// and the absolute time, in the user's locale with seconds, in a tooltip.
//
// A relative time ticks on the shared clock (clock.ts), one interval for the whole page; the time of
// day never changes, so it doesn't subscribe. Neither is in a live region, so nothing is announced.

import { useNow } from '../clock.js';
import { absoluteTime, clockTime, relativeTime, updatedAgo } from '../format.js';
import { Tooltip } from './Tooltip.js';

export interface TimestampProps {
  /** An ISO time. */
  at: string;
  /** `relative` ("5m ago"); `updated` ("updated 7s ago"), for the header; or `time` ("11:06"), the time of day. */
  format?: 'relative' | 'updated' | 'time';
  /** Text before the time, such as "Active ". */
  prefix?: string;
  className?: string;
}

export function Timestamp(props: TimestampProps) {
  return props.format === 'time' ? <TimeOfDay {...props} /> : <Relative {...props} />;
}

function Relative({ at, format, prefix, className }: TimestampProps) {
  const now = useNow();
  const text = format === 'updated' ? updatedAgo(at, now) : relativeTime(at, now);
  return <Shown at={at} prefix={prefix} className={className} text={text} />;
}

function TimeOfDay({ at, prefix, className }: TimestampProps) {
  const text = clockTime(at);
  return text === undefined ? null : <Shown at={at} prefix={prefix} className={className} text={text} />;
}

function Shown({ at, prefix, className, text }: { at: string; prefix: string | undefined; className: string | undefined; text: string }) {
  return (
    <Tooltip content={absoluteTime(at)} relation="none">
      <time className={className} dateTime={at}>
        {prefix}
        {text}
      </time>
    </Tooltip>
  );
}
