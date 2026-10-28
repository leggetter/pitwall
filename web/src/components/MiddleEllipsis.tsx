// A path cut in the middle when there isn't room (docs/design-system.md, 5: "middle ellipsis"): the
// start ends in "…" and the last segment stays. CSS can only cut text at its end, so the text is two
// spans: the start, which shrinks with an ellipsis, and the end, which doesn't. Both are in the DOM
// in full, so screen readers, find in page and copying get the whole text.

import { middleEllipsisParts } from '../format.js';

export interface MiddleEllipsisProps {
  /** Plain text (plainText()). */
  text: string;
  className?: string;
  /** Where to cut it: a path's last segment stays by default; fileNameParts keeps a file's extension (W82). */
  parts?: (text: string) => { start: string; end: string };
}

/** How much of the start always shows, in characters, before the end starts giving way too. */
const START_MIN_CH = 4;

export function MiddleEllipsis({ text, className, parts = middleEllipsisParts }: MiddleEllipsisProps) {
  const { start, end } = parts(text);
  return (
    <span className={className ? `middle-ellipsis ${className}` : 'middle-ellipsis'}>
      <span className="middle-ellipsis-start" style={end ? { minWidth: `${Math.min(start.length, START_MIN_CH)}ch` } : undefined}>
        {start}
      </span>
      {end && <span className="middle-ellipsis-end">{end}</span>}
    </span>
  );
}
