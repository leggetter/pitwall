// Text in pitwall's words that may name a command in backticks, as the supervisor's held error names
// `claude stop <id>` (W113): the command in code style, never the backticks (5: Casing and style).

import { codeParts } from '../supervisor.js';

export function CodeText({ text }: { text: string }) {
  return (
    <>
      {codeParts(text).map((part, index) => (part.code ? <code key={index}>{part.text}</code> : <span key={index}>{part.text}</span>))}
    </>
  );
}

/** The same text with the backticks taken out, for a tooltip or anything else that's a plain string. */
export const withoutBackticks = (text: string) => codeParts(text).map((part) => part.text).join('');
