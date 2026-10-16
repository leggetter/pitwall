// Plain-text helpers for transcript text: truncating it, finding its fenced
// code blocks, and stripping markdown syntax so a row reads as prose. All pure.

/**
 * At most `max` characters. A cut text ends with `…`, within the limit, and
 * never splits a surrogate pair.
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = max - 1;
  if (isHighSurrogate(text.charCodeAt(cut - 1))) cut -= 1;
  return `${text.slice(0, cut).trimEnd()}…`;
}

/** The first `max` UTF-16 code units of `text`, without leaving half a surrogate pair at the end. */
export function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

// --- Fenced code ---------------------------------------------------------------

export interface MarkedLine {
  text: string;
  /** Part of a fenced code block, its fences included. */
  code: boolean;
  /** The opening fence of a code block. */
  opensFence: boolean;
}

const FENCE_OPEN = /^\s*(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;

/**
 * Splits text into lines and marks the ones inside fenced code blocks. A fence
 * may be indented, as inside a list item. A block that is never closed runs
 * to the end of the text, as in CommonMark.
 */
export function markFences(text: string): MarkedLine[] {
  const marked: MarkedLine[] = [];
  let fence: string | undefined;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (fence !== undefined) {
      marked.push({ text: line, code: true, opensFence: false });
      const marker = FENCE_CLOSE.exec(line)?.[1];
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    const marker = open?.[1];
    // A backtick fence's info string can't contain a backtick: "```a```" is inline code.
    if (marker !== undefined && !(marker[0] === '`' && (open?.[2] ?? '').includes('`'))) {
      fence = marker;
      marked.push({ text: line, code: true, opensFence: true });
      continue;
    }
    marked.push({ text: line, code: false, opensFence: false });
  }
  return marked;
}

// --- Markdown ------------------------------------------------------------------

export const CODE_PLACEHOLDER = '[code]';
const TABLE_CELL_SEPARATOR = ' · ';

/**
 * Markdown as plain text, for showing a message in a row:
 * - a fenced code block becomes `[code]`, and inline code loses its backticks;
 * - paired `**`, `__`, `*` and `_` are removed, but only at word boundaries,
 *   so `snake_case` and `2*3*4` survive;
 * - heading markers, blockquote markers and horizontal rules are removed;
 * - unordered list markers become `- `; ordered ones are kept;
 * - table separator rows are dropped, and rows become their cells joined with ` · `;
 * - `[text](url)` becomes `text`, and `![alt](url)` becomes `alt`;
 * - backslash escapes lose their backslash;
 * - runs of three or more newlines collapse to two.
 *
 * HTML is left as it is: the UI renders the result as text, never as markup.
 */
export function stripMarkdown(markdown: string): string {
  const lines = markFences(markdown);
  const out: string[] = [];
  let inTable = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as MarkedLine;
    if (line.code) {
      inTable = false;
      if (line.opensFence) out.push(CODE_PLACEHOLDER);
      continue;
    }
    const text = line.text;
    if (isTableSeparator(text)) {
      inTable = true;
      continue;
    }
    const next = lines[i + 1];
    const startsTable = next !== undefined && !next.code && text.includes('|') && isTableSeparator(next.text);
    if (startsTable || (inTable && text.includes('|') && text.trim() !== '') || isPipedRow(text)) {
      out.push(tableRow(text));
      continue;
    }
    inTable = false;
    const plain = stripLine(text);
    if (plain !== undefined) out.push(plain);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

const HEADING = /^\s{0,3}#{1,6}(?:\s+|$)/;
const HEADING_CLOSE = /\s+#+\s*$/;
const BLOCKQUOTE = /^\s*(?:>\s?)+/;
const THEMATIC_BREAK = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const UNORDERED_ITEM = /^(\s*)[-*+]\s+/;

export function isHeading(line: string): boolean {
  return HEADING.test(line);
}

export function isThematicBreak(line: string): boolean {
  return THEMATIC_BREAK.test(line);
}

/** One line of markdown as plain text, or undefined for a line that is only syntax, like a horizontal rule. */
function stripLine(line: string): string | undefined {
  let text = line.replace(BLOCKQUOTE, '');
  if (THEMATIC_BREAK.test(text)) return undefined;
  if (HEADING.test(text)) text = text.replace(HEADING, '').replace(HEADING_CLOSE, '');
  else text = text.replace(UNORDERED_ITEM, '$1- ');
  return stripInline(text);
}

/** A GFM table separator row, such as `|---|:---:|`. */
function isTableSeparator(line: string): boolean {
  if (!line.includes('|')) return false;
  const cells = splitCells(line);
  return cells.length > 0 && cells.every((cell) => /^\s*:?-+:?\s*$/.test(cell));
}

/** A row written with pipes at both ends, even without a separator row to make it a table. */
function isPipedRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 1 && trimmed.startsWith('|') && trimmed.endsWith('|');
}

function tableRow(line: string): string {
  return splitCells(line.replace(BLOCKQUOTE, ''))
    .map((cell) => stripInline(cell.trim()))
    .filter((cell) => cell !== '')
    .join(TABLE_CELL_SEPARATOR);
}

/** A row's cells, split on pipes that aren't escaped, without the empty cells outside the edge pipes. */
function splitCells(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split(/(?<!\\)\|/);
}

// Inline syntax. Code spans and backslash escapes are set aside first, so
// nothing inside them is read as emphasis or links, and put back last.

const CODE_SPAN = /(?<!`)(`+)(?!`)([^\n]*?[^`\n])\1(?!`)/g;
const ESCAPE = /\\([!-/:-@[-`{-~])/g;
const LINK_TARGET = String.raw`\(\s*[^()\s]*(?:\([^()\s]*\)[^()\s]*)*(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)`;
const IMAGE = new RegExp(String.raw`!\[([^\]]*)\]${LINK_TARGET}`, 'g');
const LINK = new RegExp(String.raw`\[([^\]]+)\]${LINK_TARGET}`, 'g');
const WORD = String.raw`\p{L}\p{N}_`;
const EMPHASIS = [
  new RegExp(String.raw`(?<![${WORD}])\*\*(?=\S)(.*?\S)\*\*(?![${WORD}])`, 'gu'),
  new RegExp(String.raw`(?<![${WORD}])__(?=\S)(.*?\S)__(?![${WORD}])`, 'gu'),
  new RegExp(String.raw`(?<![${WORD}*])\*(?=[^\s*])(.*?[^\s*])\*(?![${WORD}*])`, 'gu'),
  new RegExp(String.raw`(?<![${WORD}])_(?=[^\s_])(.*?[^\s_])_(?![${WORD}])`, 'gu'),
];
const PLACEHOLDER = /(\d+)/g;

function stripInline(text: string): string {
  const kept: string[] = [];
  const keep = (value: string) => `${kept.push(value) - 1}`;
  let out = text
    .replace(CODE_SPAN, (_match, _ticks: string, code: string) => keep(trimCodeSpan(code)))
    .replace(ESCAPE, (_match, char: string) => keep(char))
    .replace(IMAGE, '$1')
    .replace(LINK, '$1');
  for (const pattern of EMPHASIS) out = out.replace(pattern, '$1');
  return out.replace(PLACEHOLDER, (match, index: string) => kept[Number(index)] ?? match);
}

/** CommonMark drops one space from each end of a code span that has both, so `` ` `a` ` `` can be written. */
function trimCodeSpan(code: string): string {
  return code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '' ? code.slice(1, -1) : code;
}
