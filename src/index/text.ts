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

/** The last `max` UTF-16 code units of `text`, without leaving half a surrogate pair at the start. */
export function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  const start = text.length - max;
  return text.slice(isLowSurrogate(text.charCodeAt(start)) ? start + 1 : start);
}

// Terminal escapes (CSI, OSC and two-character ones), then any control character left: C0, DEL and
// C1, and the bidi marks (U+061C, U+200E, U+200F), embeddings and overrides (U+202A to U+202E) and
// isolates (U+2066 to U+2069), which would make the line read differently from what it says.
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-_]/g;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;

/**
 * Text from an internal file as one line of plain text: terminal escapes, control characters and
 * bidi controls removed, line breaks and tabs as spaces, whitespace collapsed, trimmed, and at most
 * `max` characters (truncate()). Bounded first, so a huge value isn't scanned in full.
 */
export function plainLine(raw: string, max: number): string {
  const plain = cap(raw, 8 * max).replace(ESCAPES, '').replace(/[\t\n\v\f\r]+/g, ' ').replace(CONTROLS, '');
  return truncate(plain.replace(/\s+/g, ' ').trim(), max);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
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
 *
 * `maxProse` bounds the work for a caller that shows only the start: at most
 * that many characters outside code blocks are read, and the text stops where
 * they run out, even mid-line. Code blocks don't count, so a long one at the
 * start doesn't hide the prose after it. Some inline patterns take time that
 * grows with the square of a line's length on hostile input, so callers that
 * can't bound the text themselves should pass a limit.
 */
export function stripMarkdown(markdown: string, maxProse = Number.POSITIVE_INFINITY): string {
  const lines = markFences(markdown);
  const out: string[] = [];
  let inTable = false;
  let budget = maxProse;
  for (let i = 0; i < lines.length && budget > 0; i++) {
    const line = lines[i] as MarkedLine;
    if (line.code) {
      inTable = false;
      if (line.opensFence) out.push(CODE_PLACEHOLDER);
      continue;
    }
    let text = line.text;
    if (text.length > budget) {
      text = cap(text, budget);
      budget = 0;
    } else {
      budget -= text.length;
    }
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
  if (HEADING.test(text)) text = withoutClosingHashes(text.replace(HEADING, ''));
  else text = text.replace(UNORDERED_ITEM, '$1- ');
  return stripInline(text);
}

/**
 * A heading's text without its closing sequence: `Summary ##` becomes
 * `Summary`, but `C#` keeps its `#`, because the sequence must follow
 * whitespace. Done by hand: the pattern `\s+#+\s*$` is tried at every
 * position, which is quadratic on a long run of spaces.
 */
function withoutClosingHashes(text: string): string {
  const trimmed = text.trimEnd();
  let end = trimmed.length;
  while (end > 0 && trimmed[end - 1] === '#') end--;
  if (end === trimmed.length) return text;
  const before = trimmed.slice(0, end);
  const kept = before.trimEnd();
  return kept === before ? text : kept;
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
// A link target: `(destination "title")`, either part optional. The
// destination may hold balanced parentheses, as in Wikipedia URLs. Every
// whitespace quantifier is followed by a token that can't match whitespace, so
// giving a space back fails at once. The previous pattern had `\s*`, an
// optional destination and `\s+` side by side, so on `(` and a run of spaces
// it tried every way of splitting the spaces between them: quadratic.
const LINK_DESTINATION = String.raw`(?:[^()\s]|\([^()\s]*\))+`;
const LINK_TITLE = String.raw`(?:"[^"]*"|'[^']*')`;
const LINK_TARGET = new RegExp(
  String.raw`\((?:\s*${LINK_DESTINATION}(?:\s+${LINK_TITLE})?|\s+${LINK_TITLE})?\s*\)`,
  'y',
);
const WORD = String.raw`\p{L}\p{N}_`;
/** Each pattern with the character it can't match without. */
const EMPHASIS: readonly (readonly [string, RegExp])[] = [
  ['*', new RegExp(String.raw`(?<![${WORD}])\*\*(?=\S)(.*?\S)\*\*(?![${WORD}])`, 'gu')],
  ['_', new RegExp(String.raw`(?<![${WORD}])__(?=\S)(.*?\S)__(?![${WORD}])`, 'gu')],
  ['*', new RegExp(String.raw`(?<![${WORD}*])\*(?=[^\s*])(.*?[^\s*])\*(?![${WORD}*])`, 'gu')],
  ['_', new RegExp(String.raw`(?<![${WORD}])_(?=[^\s_])(.*?[^\s_])_(?![${WORD}])`, 'gu')],
];
const PLACEHOLDER = /(\d+)/g;

/** A character that every inline pattern needs. Text without one is returned as it is. */
const INLINE_SYNTAX = /[`\\[*_]/;

/**
 * Each pattern runs only when the text holds the character it needs, so a
 * line of plain prose costs one test rather than nine replacements. That
 * matters for a message of thousands of short lines.
 */
function stripInline(text: string): string {
  if (!INLINE_SYNTAX.test(text)) return text;
  const kept: string[] = [];
  const keep = (value: string) => `${kept.push(value) - 1}`;
  let out = text;
  if (out.includes('`')) out = out.replace(CODE_SPAN, (_match, _ticks: string, code: string) => keep(trimCodeSpan(code)));
  if (out.includes('\\')) out = out.replace(ESCAPE, (_match, char: string) => keep(char));
  if (out.includes('[')) out = replaceLinks(replaceLinks(out, '!['), '[');
  for (const [char, pattern] of EMPHASIS) if (out.includes(char)) out = out.replace(pattern, '$1');
  if (kept.length === 0) return out;
  return out.replace(PLACEHOLDER, (match, index: string) => kept[Number(index)] ?? match);
}

/**
 * `![alt](target)` as `alt`, or `[text](target)` as `text`: what
 * `/!\[([^\]]*)\]TARGET/g` and `/\[([^\]]+)\]TARGET/g` would replace, a link
 * needing non-empty text. By hand, because a pattern retried from every `[`
 * scans to the same `]` each time, which is quadratic on a run of `[`: here,
 * when the target after a `]` doesn't match, every opener before that `]`
 * fails the same way, so the search moves past it.
 */
function replaceLinks(text: string, opener: '![' | '['): string {
  let out = '';
  let copied = 0;
  let from = 0;
  for (;;) {
    const start = text.indexOf(opener, from);
    if (start === -1) break;
    const labelStart = start + opener.length;
    const close = text.indexOf(']', labelStart);
    // No `]` after this opener, so none after any later opener either.
    if (close === -1) break;
    LINK_TARGET.lastIndex = close + 1;
    const target = opener === '[' && close === labelStart ? null : LINK_TARGET.exec(text);
    if (target === null) {
      from = close + 1;
      continue;
    }
    out += text.slice(copied, start) + text.slice(labelStart, close);
    copied = from = close + 1 + target[0].length;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/** CommonMark drops one space from each end of a code span that has both, so `` ` `a` ` `` can be written. */
function trimCodeSpan(code: string): string {
  return code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '' ? code.slice(1, -1) : code;
}

// --- Whole messages ------------------------------------------------------------

/**
 * How much inline work a whole message may cost before its long lines are
 * stripped in pieces. A line's work is its length times how many characters
 * on it can open inline syntax (`` ` ``, `\`, `[`, `*` and `_`): on hostile
 * input, the inline patterns take time that grows with that product. Real
 * messages use a small fraction of this; the W6 inputs use it up at once.
 */
export const MESSAGE_WORK_MAX = 4 * 1024 * 1024;
/** The length of the pieces a line is stripped in once the work runs out. */
export const LINE_PIECE_LENGTH = 128;

/**
 * `stripMarkdown` for a whole message, in time bounded however hostile the
 * text is, for showing a message in full.
 *
 * Lines are stripped as `stripMarkdown` strips them while the work budget
 * lasts. After that, a line longer than `pieceLength` is stripped
 * `pieceLength` characters at a time, which can leave syntax that spans two
 * pieces as it is. Lines shorter than that are always stripped whole, so the
 * total work is at most the budget plus the text's length times `pieceLength`.
 */
export function stripMarkdownBounded(
  markdown: string,
  workMax: number = MESSAGE_WORK_MAX,
  pieceLength: number = LINE_PIECE_LENGTH,
): string {
  const out: string[] = [];
  // Consecutive lines stripped whole, together, so tables and fences keep
  // their context. A run never splits a fence: only a line outside one ends it.
  let run: string[] = [];
  let work = workMax;
  const flush = () => {
    if (run.length > 0) out.push(stripMarkdown(run.join('\n')));
    run = [];
  };
  for (const line of markFences(markdown)) {
    if (line.code || line.text.length <= pieceLength) {
      run.push(line.text);
      continue;
    }
    const cost = line.text.length * syntaxCount(line.text);
    if (cost <= work) {
      work -= cost;
      run.push(line.text);
      continue;
    }
    work = 0;
    flush();
    out.push(stripPieces(line.text, pieceLength));
  }
  flush();
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** How many characters of `text` can open inline syntax. */
function syntaxCount(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // ` \ [ * _
    if (code === 0x60 || code === 0x5c || code === 0x5b || code === 0x2a || code === 0x5f) count++;
  }
  return count;
}

/**
 * Not whitespace, not a word character and not markdown, so a piece that
 * starts with it isn't read as a heading, list item, quote, rule, fence or
 * table row, and emphasis next to it reads as it does next to a space.
 */
const PIECE_START = '​';

/** One line, stripped a piece at a time. Every piece after the first is stripped as the middle of a line. */
function stripPieces(line: string, pieceLength: number): string {
  let out = '';
  for (let start = 0; start < line.length; ) {
    let end = Math.min(start + pieceLength, line.length);
    if (end < line.length && end - 1 > start && isHighSurrogate(line.charCodeAt(end - 1))) end -= 1;
    const piece = line.slice(start, end);
    if (start === 0) {
      out += stripMarkdown(piece);
    } else {
      const stripped = stripMarkdown(PIECE_START + piece);
      out += stripped.startsWith(PIECE_START) ? stripped.slice(PIECE_START.length) : stripped;
    }
    start = end;
  }
  return out;
}
