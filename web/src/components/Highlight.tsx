// The filter's matches, highlighted (docs/design-system.md, Search): in session names, titles, group
// labels and paths, each match is a <mark> in --pw-highlight. The list pane provides the filter's
// text, so a row or group header only says which of its text can match.

import { createContext, Fragment, useContext, type ReactNode } from 'react';
import { matchRanges } from '../sessions.js';

/** The filter's text, as filterNeedle() gives it: trimmed and lower case. Empty highlights nothing. */
export const HighlightContext = createContext('');

/** `text`, already plain (plainText()), with each match of the filter in a <mark>. */
export function Highlight({ text }: { text: string }) {
  const ranges = matchRanges(text, useContext(HighlightContext));
  if (ranges.length === 0) return text;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push(<Fragment key={`text-${at}`}>{text.slice(at, start)}</Fragment>);
    parts.push(
      <mark key={`match-${start}`} className="match">
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  if (at < text.length) parts.push(<Fragment key={`text-${at}`}>{text.slice(at)}</Fragment>);
  return parts;
}
