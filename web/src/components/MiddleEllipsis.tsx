// A path cut in the middle when there isn't room (docs/design-system.md, 5: "middle ellipsis"): the
// start ends in "…" and the last segment stays. CSS can only cut text at its end, so the text is two
// spans: the start, which shrinks with an ellipsis, and the end, which doesn't. Both are in the DOM
// in full, so screen readers, find in page and copying get the whole text.

import { middleEllipsisParts } from '../format.js';

export interface MiddleEllipsisProps {
  /** Plain text (plainText()). */
  text: string;
  className?: string;
}

export function MiddleEllipsis({ text, className }: MiddleEllipsisProps) {
  const { start, end } = middleEllipsisParts(text);
  return (
    <span className={className ? `middle-ellipsis ${className}` : 'middle-ellipsis'}>
      <span className="middle-ellipsis-start">{start}</span>
      {end && <span className="middle-ellipsis-end">{end}</span>}
    </span>
  );
}
