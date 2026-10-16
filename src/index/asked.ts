// Did a message end its turn by asking the user something? A heuristic over
// the text of the newest assistant message. Interactive sessions only report
// busy or idle, so this is the only way to tell "done" from "over to you".

import type { AskedYou } from '../shared/protocol.js';
import { isHeading, isThematicBreak, markFences, stripMarkdown, tail, truncate, type MarkedLine } from './text.js';

export const EXCERPT_MAX = 200;
/**
 * How much of one line is stripped of markdown: the start, for an excerpt, and
 * for a trailing question also the end. Some inline patterns are quadratic in
 * a line's length on hostile input, so this bounds the work per line while
 * the message as a whole is still read to its end.
 */
export const LINE_STRIP_MAX = 1024;

/**
 * Whether `fullText`, the whole raw markdown of an assistant message, asks the
 * user something. Fenced code blocks are ignored.
 *
 * 1. An "Open questions" section decides, when there is one: asked unless its
 *    content is empty, "None" or "N/A". The excerpt is its first list item, or
 *    else its first sentence.
 * 2. Otherwise asked when the last non-empty line ends with a question mark,
 *    optionally followed by closing quotes or brackets. The excerpt is that line.
 *
 * Excerpts are plain text, on one line, at most 200 characters. Lines are
 * read whole, but only the first and last 1024 characters of a line are
 * stripped of markdown.
 */
export function detectAskedYou(fullText: string): AskedYou | undefined {
  const lines = markFences(fullText);
  const section = openQuestions(lines);
  if (section !== undefined) return section.asked;
  return trailingQuestion(lines);
}

// --- Open questions ------------------------------------------------------------

/**
 * The start of a label line. After any blockquote marker, list marker, `#`,
 * `*` and `_`: "open question" or "open questions", then the closing emphasis
 * and a colon. The rest of the line follows the match.
 *
 * `lead` starts with `*`, `_` or `#`, so it never competes with the
 * whitespace before it, and nothing after "questions" can fail: two
 * quantifiers that can both match the same spaces make a failed match try
 * every split between them, which is quadratic on a long run of spaces.
 */
const LABEL =
  /^[\s>]*(?:(?:[-+]|\d+[.)])\s+)?(?<lead>(?:[*_#][*_#\s]*)?)open[*_\s]+questions?(?<close>[*_]*)\s*(?<colon>:?)[*_]*\s*/i;
const LIST_ITEM = /^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+/;
/** A line that starts a new labelled part, such as `**Next steps:**` or a line that is all bold. */
const BOLD_LABEL = /^\s*(\*\*|__)(?:[^*_\n]+?(?::\s*\1|\1\s*:)|[^*_\n]+\1\s*$)/;
const NONE = /^(?:none|n\/a)[.!…]*$/i;

interface Section {
  /** Undefined when the section says there are no questions. */
  asked: AskedYou | undefined;
}

/** The last "Open questions" section, or undefined when the message has none. */
function openQuestions(lines: readonly MarkedLine[]): Section | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as MarkedLine;
    if (line.code) continue;
    const match = LABEL.exec(line.text);
    const groups = match?.groups;
    if (match === null || groups === undefined) continue;
    const rest = line.text.slice(match[0].length);
    const heading = (groups.lead ?? '').includes('#');
    // "Open questions about the API remain." is prose, not a label: a label
    // has a colon, is wrapped in emphasis, is a heading, or stands alone.
    if (groups.colon === '' && groups.close === '' && !heading && rest.trim() !== '') continue;
    const inline = heading && groups.colon === '' ? '' : rest;
    return { asked: judge(inline, sectionLines(lines, i + 1, plainLine(inline) !== '')) };
  }
  return undefined;
}

/**
 * The section's lines after its label, up to the first of: a blank line
 * followed by a line that isn't a list item, another bold label, a heading or
 * a horizontal rule. Blank lines before the content starts don't end it, so a
 * heading can be followed by a blank line and a paragraph. Code lines are skipped.
 */
function sectionLines(lines: readonly MarkedLine[], start: number, started: boolean): string[] {
  const content: string[] = [];
  let afterBlank = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] as MarkedLine;
    if (line.code) continue;
    const text = line.text;
    if (text.trim() === '') {
      afterBlank = true;
      continue;
    }
    if (isHeading(text) || isThematicBreak(text) || BOLD_LABEL.test(text)) break;
    if (afterBlank && (started || content.length > 0) && !LIST_ITEM.test(text)) break;
    afterBlank = false;
    content.push(text);
  }
  return content;
}

function judge(rest: string, following: readonly string[]): AskedYou | undefined {
  const inline = plainLine(rest);
  // "**Open questions:** None" answers itself, whatever follows it.
  if (NONE.test(inline)) return undefined;
  const lines = (inline === '' ? following : [rest, ...following]).filter((line) => plainLine(line) !== '');
  const all = lines.map(plainLine).join(' ');
  if (all === '' || NONE.test(all)) return undefined;
  return { reason: 'open-questions', excerpt: excerpt(sectionExcerpt(lines, all)) };
}

/**
 * The first list item when the section starts with one, or when its first
 * line introduces a list ("Two things:"). Otherwise its first sentence.
 */
function sectionExcerpt(lines: readonly string[], all: string): string {
  const first = lines[0] ?? '';
  if (LIST_ITEM.test(first)) return plainLine(first);
  const item = lines.find((line) => LIST_ITEM.test(line));
  if (item !== undefined && plainLine(first).endsWith(':')) return plainLine(item);
  return firstSentence(all);
}

function firstSentence(text: string): string {
  return /^.*?[.?!](?=\s|$)/.exec(text)?.[0] ?? text;
}

// --- A question at the end ----------------------------------------------------

/** A line ending with a question mark, then any closing quotes, brackets or emphasis. */
const ENDS_WITH_QUESTION = /\?["'”’»)\]}*_]*$/;

function trailingQuestion(lines: readonly MarkedLine[]): AskedYou | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as MarkedLine;
    if (line.code) continue;
    const start = plainLine(line.text);
    // For a long line, whether it ends with a question is read from its end.
    const end = line.text.length > LINE_STRIP_MAX ? plainLine(tail(line.text, LINE_STRIP_MAX)) : start;
    if (start === '' && end === '') continue;
    return ENDS_WITH_QUESTION.test(end) ? { reason: 'question', excerpt: excerpt(start || end) } : undefined;
  }
  return undefined;
}

// --- Text ------------------------------------------------------------------------

/**
 * One line as plain text: markdown stripped, without a list marker, whitespace
 * collapsed. Only its first 1024 characters are read.
 */
function plainLine(line: string): string {
  return stripMarkdown(line, LINE_STRIP_MAX).replace(LIST_ITEM, '').replace(/\s+/g, ' ').trim();
}

function excerpt(text: string): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), EXCERPT_MAX);
}
