// Markdown in the conversation (docs/design-system.md, 4: Markdown in messages): Claude's messages
// and other sessions' arrive as the markdown they were written in, and the page shows a safe subset
// of it as its own elements (components/Markdown.tsx). This file parses it to a small tree. Nothing
// here makes HTML: the tree holds text, and React renders the text as text (6.1, rule 16).
//
// - Blocks: paragraphs, whose single newlines are line breaks, as Claude's terminal shows them; ATX
//   headings; fenced code (``` and ~~~), where one that's never closed runs to the end; bullet and
//   ordered lists, nested; block quotes; thematic breaks; GFM tables.
// - Inline: bold, italic, both, ~~strikethrough~~, code spans of any backtick-run length, backslash
//   escapes, links from [text](url), <url> and bare URLs, and images, which become their alt text.
// - Only absolute http: and https: URLs become links, as the browser parses them. A link to anything
//   else shows as the literal text it was written as.
// - Code is literal, but its bare http: and https: URLs are links too, under the same rule (W37), so a
//   draft or a command that Claude puts in code can be opened from it. Markdown's own link syntax in
//   code, [text](url) and <url>, stays text, as everything else in code does, and so does a code span
//   inside a link's text, since links can't nest.
// - Anything else shows as the literal text it is: raw HTML, entities, reference links, setext
//   headings, indented code, a single ~, footnotes and task-list markers.
//
// It's bounded, since the text is a session's: every scan moves forward, as CommonMark's reference
// parser's do, so the time grows with the text's length, and lists and quotes nest at most
// MAX_BLOCK_DEPTH deep, emphasis and links MAX_INLINE_DEPTH, past which the syntax is text. Drawing
// what it parses is bounded too: a message that would take more than MAX_ELEMENTS elements is shown
// as the text it was written in (elementCount), and the links in code count towards it.

/** The most lists and quotes nest. A marker deeper than this is text. */
export const MAX_BLOCK_DEPTH = 8;
/** The most emphasis, strikethrough and links nest. Delimiters deeper than this are text. */
export const MAX_INLINE_DEPTH = 16;
/** A table with more columns than this is text. */
export const MAX_TABLE_COLUMNS = 64;
/**
 * The most elements a message's markdown may take on the page (elementCount). Past it, the message
 * is shown as the text it was written in. 32 KiB of dense everyday markdown takes about 4,000, which
 * headless Chrome drew in 25 to 30 ms; 32 KiB of hostile input can take over 30,000, which took it
 * 150 ms or more (W36).
 */
export const MAX_ELEMENTS = 5_000;
/** The longest language label kept from a fence's info string. */
const MAX_LANGUAGE = 40;

export type Align = 'left' | 'center' | 'right' | undefined;

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'break' }
  | { type: 'strong' | 'em' | 'del'; children: Inline[] }
  /**
   * `text` is the code as written. `linked`, only when it holds a bare http: or https: URL, is the same
   * text with those URLs as links: text and link nodes only, read once, here (linkedCode).
   */
  | { type: 'code'; text: string; linked?: Inline[] }
  /** `href` is the URL as the browser parsed it: absolute, http: or https:. */
  | { type: 'link'; href: string; children: Inline[] };

export type Block =
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  /**
   * `language` is the first word of the info string, or empty. `closed` is false when the fence never
   * closed. `text` is the code as written, and `linked` the same text with its bare URLs as links, as
   * for a code span.
   */
  | { type: 'code'; language: string; text: string; closed: boolean; linked?: Inline[] }
  | { type: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { type: 'quote'; children: Block[] }
  | { type: 'rule' }
  | { type: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] };

/** Parses markdown to blocks. Never throws. */
export function parseMarkdown(source: string): Block[] {
  return parseBlocks(source.replace(/\r\n?/g, '\n').split('\n'), 0);
}

/**
 * About how many elements the blocks take on the page: one for each element, and more for the parts
 * that bring their own, a link's tooltip and a code block's bar, Copy button and scroll box. A link in
 * code counts as any link does. Stops counting once past `limit`.
 */
export function elementCount(blocks: Block[], limit = Number.POSITIVE_INFINITY): number {
  let count = 0;
  const inline = (inlines: Inline[]) => {
    for (const item of inlines) {
      if (count > limit) return;
      if (item.type === 'text') continue;
      count += item.type === 'link' ? 4 : 1;
      if ('children' in item) inline(item.children);
      else if (item.type === 'code' && item.linked) inline(item.linked);
    }
  };
  const block = (list: Block[]) => {
    for (const item of list) {
      if (count > limit) return;
      switch (item.type) {
        case 'paragraph':
        case 'heading':
          count += 1;
          inline(item.children);
          break;
        case 'code':
          count += 10;
          if (item.linked) inline(item.linked);
          break;
        case 'list':
          count += 1 + item.items.length;
          for (const entry of item.items) block(entry);
          break;
        case 'quote':
          count += 1;
          block(item.children);
          break;
        case 'rule':
          count += 1;
          break;
        case 'table':
          count += 4 + item.head.length + item.rows.length * (1 + item.align.length);
          for (const cell of [...item.head, ...item.rows.flat()]) inline(cell);
          break;
      }
    }
  };
  block(blocks);
  return count;
}

/** The absolute http: or https: URL in `text`, as the browser parses it, or undefined for anything else. */
export function httpUrl(text: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '' ? url : undefined;
}

// --- Blocks ----------------------------------------------------------------------------------------

/** Where the spaces and tabs from `at` end. By hand: `/[ \t]+$/` is quadratic on a long run of them. */
function spacesAt(text: string, at: number): number {
  let i = at;
  while (text[i] === ' ' || text[i] === '\t') i++;
  return i;
}

function isBlank(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** Up to three spaces: where a block's marker may start. */
function markerStart(line: string): number {
  let i = 0;
  while (i < 3 && line[i] === ' ') i++;
  return i;
}

/** The columns of a line's leading whitespace, a tab reaching the next multiple of 4. */
function indentOf(line: string): number {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === ' ') col += 1;
    else if (line[i] === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

/** The line without its first `cols` columns of indent. A tab across the cut leaves its remaining columns as spaces. */
function removeIndent(line: string, cols: number): string {
  let col = 0;
  let i = 0;
  while (i < line.length && col < cols) {
    if (line[i] === ' ') col += 1;
    else if (line[i] === '\t') {
      const next = col + 4 - (col % 4);
      if (next > cols) return ' '.repeat(next - cols) + line.slice(i + 1);
      col = next;
    } else break;
    i++;
  }
  return line.slice(i);
}

interface Fence {
  indent: number;
  char: '`' | '~';
  length: number;
  info: string;
}

function fenceOpen(line: string): Fence | undefined {
  const i = markerStart(line);
  const char = line[i];
  if (char !== '`' && char !== '~') return undefined;
  let j = i;
  while (line[j] === char) j++;
  if (j - i < 3) return undefined;
  const info = line.slice(j).trim();
  // A backtick fence's info string can't hold a backtick: "```a```" is a code span.
  if (char === '`' && info.includes('`')) return undefined;
  return { indent: i, char, length: j - i, info };
}

function closesFence(line: string, fence: Fence): boolean {
  const i = markerStart(line);
  let j = i;
  while (line[j] === fence.char) j++;
  return j - i >= fence.length && isBlank(line.slice(j));
}

function isHeading(line: string): boolean {
  const i = markerStart(line);
  let j = i;
  while (j < line.length && j - i <= 6 && line[j] === '#') j++;
  const level = j - i;
  return level >= 1 && level <= 6 && (j === line.length || line[j] === ' ' || line[j] === '\t');
}

function heading(line: string): Block {
  const i = markerStart(line);
  let j = i;
  while (line[j] === '#') j++;
  const level = (j - i) as 1 | 2 | 3 | 4 | 5 | 6;
  return { type: 'heading', level, children: parseInline(withoutClosingHashes(line.slice(j).trim())) };
}

/**
 * A heading's text without its closing sequence: `Summary ##` becomes `Summary`, but `C#` keeps its
 * `#`, because the sequence must follow a space. By hand, as a pattern would be quadratic on spaces.
 */
function withoutClosingHashes(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end--;
  if (end === text.length) return text;
  if (end === 0) return '';
  const before = text[end - 1];
  return before === ' ' || before === '\t' ? text.slice(0, end).trimEnd() : text;
}

function isRule(line: string): boolean {
  let i = markerStart(line);
  const char = line[i];
  if (char !== '-' && char !== '*' && char !== '_') return false;
  let count = 0;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === char) count++;
    else if (c !== ' ' && c !== '\t') return false;
  }
  return count >= 3;
}

function isQuote(line: string): boolean {
  return line[markerStart(line)] === '>';
}

/** A quote line without its `>` and the one space after it. */
function unquote(line: string): string {
  let i = markerStart(line) + 1;
  if (line[i] === ' ') i++;
  else if (line[i] === '\t') return removeIndent(line.slice(i), 2);
  return line.slice(i);
}

interface Marker {
  ordered: boolean;
  /** The bullet character, or an ordered list's delimiter: items of one list share it. */
  kind: string;
  start: number;
  /** Where the item's content starts, in columns: what a line must be indented by to belong to it. */
  content: number;
  /** The first line's content. */
  rest: string;
}

function listMarker(line: string): Marker | undefined {
  const i = markerStart(line);
  const c = line[i];
  let j: number;
  let ordered = false;
  let kind: string;
  let start = 1;
  if (c === '-' || c === '*' || c === '+') {
    j = i + 1;
    kind = c;
  } else if (c !== undefined && c >= '0' && c <= '9') {
    j = i;
    while (j - i < 9 && (line[j] ?? '') >= '0' && (line[j] ?? '') <= '9') j++;
    const delimiter = line[j];
    if (delimiter !== '.' && delimiter !== ')') return undefined;
    ordered = true;
    kind = delimiter;
    start = Number(line.slice(i, j));
    j++;
  } else {
    return undefined;
  }
  if (j < line.length && line[j] !== ' ' && line[j] !== '\t') return undefined;
  // The whitespace after the marker, in columns from the line's start.
  let col = j;
  let k = j;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) {
    col += line[k] === '\t' ? 4 - (col % 4) : 1;
    k++;
  }
  const spaces = col - j;
  if (k === line.length) return { ordered, kind, start, content: j + 1, rest: '' };
  // Five or more spaces: the content starts after one, as in CommonMark, where the rest is indented code.
  if (spaces > 4) return { ordered, kind, start, content: j + 1, rest: removeIndent(line.slice(j), 1) };
  return { ordered, kind, start, content: col, rest: line.slice(k) };
}

/** A line that starts a block of its own, and so ends a paragraph, a table or a lazy list line. */
function startsBlock(line: string, depth: number): boolean {
  if (fenceOpen(line) || isHeading(line) || isRule(line)) return true;
  if (depth >= MAX_BLOCK_DEPTH) return false;
  if (isQuote(line)) return true;
  const marker = listMarker(line);
  // A list interrupts a paragraph only with content, and an ordered one only from 1, so "1986. A
  // good year" on a paragraph's second line is still the paragraph.
  return marker !== undefined && marker.rest.trim() !== '' && (!marker.ordered || marker.start === 1);
}

function parseBlocks(lines: string[], depth: number): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (isBlank(line)) {
      i++;
      continue;
    }
    const fence = fenceOpen(line);
    if (fence) {
      i = readFence(lines, i, fence, blocks);
      continue;
    }
    if (isHeading(line)) {
      blocks.push(heading(line));
      i++;
      continue;
    }
    // Before list items: "- - -" and "* * *" are rules.
    if (isRule(line)) {
      blocks.push({ type: 'rule' });
      i++;
      continue;
    }
    if (depth < MAX_BLOCK_DEPTH && isQuote(line)) {
      i = readQuote(lines, i, depth, blocks);
      continue;
    }
    const marker = depth < MAX_BLOCK_DEPTH ? listMarker(line) : undefined;
    if (marker) {
      i = readList(lines, i, marker, depth, blocks);
      continue;
    }
    const table = tableHead(lines, i);
    if (table) {
      i = readTable(lines, i, table, depth, blocks);
      continue;
    }
    i = readParagraph(lines, i, depth, blocks);
  }
  return blocks;
}

function readFence(lines: string[], i: number, fence: Fence, blocks: Block[]): number {
  const content: string[] = [];
  let j = i + 1;
  let closed = false;
  for (; j < lines.length; j++) {
    const line = lines[j] as string;
    if (closesFence(line, fence)) {
      closed = true;
      j++;
      break;
    }
    // Lines lose as much indent as the opening fence had.
    content.push(removeIndent(line, Math.min(fence.indent, indentOf(line))));
  }
  const language = (fence.info.split(/[ \t]/, 1)[0] ?? '').slice(0, MAX_LANGUAGE);
  const text = content.join('\n');
  const linked = linkedCode(text);
  blocks.push(linked ? { type: 'code', language, text, closed, linked } : { type: 'code', language, text, closed });
  return j;
}

function readQuote(lines: string[], i: number, depth: number, blocks: Block[]): number {
  const inner: string[] = [];
  let j = i;
  while (j < lines.length && isQuote(lines[j] as string)) {
    inner.push(unquote(lines[j] as string));
    j++;
  }
  blocks.push({ type: 'quote', children: parseBlocks(inner, depth + 1) });
  return j;
}

function sameList(a: Marker, b: Marker): boolean {
  return a.ordered === b.ordered && a.kind === b.kind;
}

function readList(lines: string[], i: number, first: Marker, depth: number, blocks: Block[]): number {
  const items: Block[][] = [];
  let marker = first;
  let j = i;
  for (;;) {
    const item = [marker.rest];
    let blank = false;
    // Whether the item's lines so far end inside a fence: a lazy line can't continue that.
    let fence = fenceOpen(marker.rest);
    j++;
    while (j < lines.length) {
      const line = lines[j] as string;
      if (isBlank(line)) {
        item.push('');
        blank = true;
        j++;
        continue;
      }
      if (indentOf(line) >= marker.content) {
        const inner = removeIndent(line, marker.content);
        item.push(inner);
        if (fence) {
          if (closesFence(inner, fence)) fence = undefined;
        } else {
          fence = fenceOpen(inner);
        }
        blank = false;
        j++;
        continue;
      }
      // Not indented enough: the list's next item, the end of the list, or a paragraph's lazy line.
      if (blank || fence || isRule(line) || listMarker(line) || startsBlock(line, depth) || isBlank(item[item.length - 1] ?? '')) break;
      item.push(line);
      j++;
    }
    while (item.length > 0 && isBlank(item[item.length - 1] as string)) item.pop();
    items.push(parseBlocks(item, depth + 1));
    const line = lines[j];
    const next = line === undefined || isRule(line) ? undefined : listMarker(line);
    if (next === undefined || !sameList(next, marker)) break;
    marker = next;
  }
  blocks.push({ type: 'list', ordered: first.ordered, start: first.start, items });
  return j;
}

function readParagraph(lines: string[], i: number, depth: number, blocks: Block[]): number {
  let j = i + 1;
  while (j < lines.length) {
    const line = lines[j] as string;
    if (isBlank(line) || startsBlock(line, depth) || tableHead(lines, j)) break;
    j++;
  }
  // Each line loses its leading whitespace; the newlines between them are line breaks.
  const text = lines
    .slice(i, j)
    .map((line) => line.slice(spacesAt(line, 0)))
    .join('\n');
  blocks.push({ type: 'paragraph', children: parseInline(text) });
  return j;
}

// GFM tables.

/** A row's cells: split on pipes, the edge pipes dropped, `\|` kept in a cell as `|`. */
function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  let from = 0;
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (c === '\\' && text[k + 1] === '|') {
      cell += `${text.slice(from, k)}|`;
      from = k + 2;
      k++;
    } else if (c === '|') {
      cells.push(cell + text.slice(from, k));
      cell = '';
      from = k + 1;
    }
  }
  cells.push(cell + text.slice(from));
  return cells;
}

const DELIMITER_CELL = /^:?-+:?$/;

/** A delimiter row's alignments, such as `|:---|---:|`, or undefined when the line isn't one. */
function delimiterRow(line: string): Align[] | undefined {
  if (!line.includes('|') || !line.includes('-')) return undefined;
  const cells = splitRow(line);
  if (cells.length > MAX_TABLE_COLUMNS) return undefined;
  const align: Align[] = [];
  for (const cell of cells) {
    const text = cell.trim();
    if (!DELIMITER_CELL.test(text)) return undefined;
    const left = text.startsWith(':');
    const right = text.endsWith(':');
    align.push(left && right ? 'center' : right ? 'right' : left ? 'left' : undefined);
  }
  return align;
}

/** A table's header and alignments, when line `i` is a header row and the next its delimiter row, with as many cells. */
function tableHead(lines: string[], i: number): { head: string[]; align: Align[] } | undefined {
  const line = lines[i];
  const next = lines[i + 1];
  if (line === undefined || next === undefined || !line.includes('|')) return undefined;
  const align = delimiterRow(next);
  if (!align) return undefined;
  const head = splitRow(line);
  return head.length === align.length ? { head, align } : undefined;
}

function readTable(lines: string[], i: number, table: { head: string[]; align: Align[] }, depth: number, blocks: Block[]): number {
  const columns = table.align.length;
  // Short rows get empty cells, and cells past the header's are dropped, as in GFM.
  const cells = (row: string[]) => Array.from({ length: columns }, (_, k) => parseInline((row[k] ?? '').trim()));
  const rows: Inline[][][] = [];
  let j = i + 2;
  while (j < lines.length) {
    const line = lines[j] as string;
    if (isBlank(line) || startsBlock(line, depth)) break;
    rows.push(cells(splitRow(line)));
    j++;
  }
  blocks.push({ type: 'table', align: table.align, head: cells(table.head), rows });
  return j;
}

// --- Inline ----------------------------------------------------------------------------------------
//
// As CommonMark's reference parsers do: one pass left to right that turns code spans, escapes,
// autolinks and line breaks into nodes, keeps runs of *, _ and ~~ as delimiters and [ and ![ as
// brackets, and closes a link at each ] that has a target; then emphasis is matched from the
// delimiters, with their "openers bottom" so no run is looked back over twice. Nodes are a linked
// list, so wrapping a run of them in emphasis or a link is constant time.

type NodeType = 'text' | 'delim' | 'code' | 'break' | 'strong' | 'em' | 'del' | 'link';

interface Node {
  type: NodeType;
  /** Text and code: the text. A delimiter: its character. */
  text: string;
  /** A delimiter: how many of its characters are left unmatched. */
  count: number;
  href: string;
  /** How deep emphasis and links nest in it, itself included. */
  depth: number;
  first: Node | null;
  last: Node | null;
  prev: Node | null;
  next: Node | null;
}

interface Delimiter {
  node: Node;
  char: string;
  /** The run's length as written, for the rule of three. */
  length: number;
  canOpen: boolean;
  canClose: boolean;
  prev: Delimiter | null;
  next: Delimiter | null;
}

interface Bracket {
  node: Node;
  image: boolean;
  active: boolean;
  /** The newest delimiter before it: emphasis inside a link is matched above this. */
  delimiter: Delimiter | null;
  prev: Bracket | null;
}

function node(type: NodeType, text = ''): Node {
  return { type, text, count: 0, href: '', depth: 0, first: null, last: null, prev: null, next: null };
}

class NodeList {
  first: Node | null = null;
  last: Node | null = null;

  append(item: Node): void {
    item.prev = this.last;
    item.next = null;
    if (this.last) this.last.next = item;
    else this.first = item;
    this.last = item;
  }

  remove(item: Node): void {
    if (item.prev) item.prev.next = item.next;
    else this.first = item.next;
    if (item.next) item.next.prev = item.prev;
    else this.last = item.prev;
    item.prev = item.next = null;
  }

  /**
   * Moves the nodes after `from` up to `to` (both exclusive; `to` null for the end) into `wrapper`,
   * which takes their place. Constant time: the run is cut out whole.
   */
  wrap(from: Node, to: Node | null, wrapper: Node): void {
    const first = from.next;
    const last = to ? to.prev : this.last;
    if (first && last && first !== to) {
      first.prev = null;
      last.next = null;
      wrapper.first = first;
      wrapper.last = last;
    }
    wrapper.prev = from;
    wrapper.next = to;
    from.next = wrapper;
    if (to) to.prev = wrapper;
    else this.last = wrapper;
  }
}

/** The deepest nesting among the nodes after `from` up to `to`, both exclusive. */
function depthBetween(from: Node, to: Node | null): number {
  let depth = 0;
  for (let at = from.next; at && at !== to; at = at.next) depth = Math.max(depth, at.depth);
  return depth;
}

const SPECIAL = /[\\`*_~[\]!<\n]/g;
const ASCII_PUNCTUATION = /^[!-/:-@[-`{-~]$/;
const WHITESPACE = /^\s$/u;
const PUNCTUATION = /^[\p{P}\p{S}]$/u;

function isAsciiPunctuation(c: string | undefined): boolean {
  return c !== undefined && ASCII_PUNCTUATION.test(c);
}

/** For flanking: the start and end of the text count as whitespace. */
function isSpace(c: string | undefined): boolean {
  return c === undefined || WHITESPACE.test(c);
}

function isPunctuation(c: string | undefined): boolean {
  return c !== undefined && PUNCTUATION.test(c);
}

/** Where each run of backticks starts, by its length, so a code span's closer is found without scanning again. */
class BacktickRuns {
  private readonly runs = new Map<number, number[]>();
  private readonly cursors = new Map<number, number>();

  constructor(text: string) {
    for (let i = 0; i < text.length; ) {
      if (text[i] !== '`') {
        const next = text.indexOf('`', i);
        if (next === -1) break;
        i = next;
        continue;
      }
      let j = i;
      while (text[j] === '`') j++;
      const list = this.runs.get(j - i);
      if (list) list.push(i);
      else this.runs.set(j - i, [i]);
      i = j;
    }
  }

  /** The start of the first run of exactly `length` backticks after `from`, or -1. Calls must move forward. */
  closer(length: number, from: number): number {
    const list = this.runs.get(length);
    if (!list) return -1;
    let cursor = this.cursors.get(length) ?? 0;
    while (cursor < list.length && (list[cursor] as number) < from) cursor++;
    this.cursors.set(length, cursor);
    return cursor < list.length ? (list[cursor] as number) : -1;
  }
}

const ANY_SPECIAL = /[\\`*_~[\]!<\n]/;

/** Parses inline markdown to nodes. Never throws. Text with no syntax in it, as most table cells are, is only checked for bare URLs. */
export function parseInline(text: string): Inline[] {
  if (text === '') return [];
  if (!ANY_SPECIAL.test(text)) return linkify(text);
  return new InlineParser(text).parse();
}

class InlineParser {
  private readonly nodes = new NodeList();
  private delimiters: Delimiter | null = null;
  private brackets: Bracket | null = null;
  private backticks: BacktickRuns | undefined;
  private buffer = '';
  private pos = 0;

  constructor(private readonly text: string) {}

  parse(): Inline[] {
    const { text } = this;
    while (this.pos < text.length) {
      SPECIAL.lastIndex = this.pos;
      const found = SPECIAL.exec(text);
      if (!found) {
        this.buffer += text.slice(this.pos);
        break;
      }
      this.buffer += text.slice(this.pos, found.index);
      this.pos = found.index;
      this.special(found[0]);
    }
    this.flush();
    this.matchEmphasis(null);
    return toInlines(this.nodes.first, false);
  }

  private flush(): void {
    if (this.buffer === '') return;
    this.nodes.append(node('text', this.buffer));
    this.buffer = '';
  }

  private add(item: Node): Node {
    this.flush();
    this.nodes.append(item);
    return item;
  }

  private special(c: string): void {
    const { text } = this;
    switch (c) {
      case '\\': {
        const next = text[this.pos + 1];
        if (next === '\n') {
          this.lineBreak(this.pos + 2);
        } else if (isAsciiPunctuation(next)) {
          this.buffer += next;
          this.pos += 2;
        } else {
          this.buffer += '\\';
          this.pos += 1;
        }
        return;
      }
      case '\n':
        this.lineBreak(this.pos + 1);
        return;
      case '`':
        this.codeSpan();
        return;
      case '*':
      case '_':
      case '~':
        this.delimiterRun(c);
        return;
      case '!':
        if (text[this.pos + 1] === '[') {
          this.openBracket(true);
        } else {
          this.buffer += '!';
          this.pos += 1;
        }
        return;
      case '[':
        this.openBracket(false);
        return;
      case ']':
        this.closeBracket();
        return;
      case '<':
        this.autolink();
        return;
    }
  }

  /** A newline: a line break, without the spaces before it or after it. */
  private lineBreak(after: number): void {
    let end = this.buffer.length;
    while (end > 0 && (this.buffer[end - 1] === ' ' || this.buffer[end - 1] === '\t')) end--;
    this.buffer = this.buffer.slice(0, end);
    this.add(node('break'));
    this.pos = spacesAt(this.text, after);
  }

  private codeSpan(): void {
    const { text } = this;
    let end = this.pos;
    while (text[end] === '`') end++;
    const length = end - this.pos;
    this.backticks ??= new BacktickRuns(text);
    const closer = this.backticks.closer(length, end);
    if (closer === -1) {
      // No run as long closes it: the backticks are text.
      this.buffer += text.slice(this.pos, end);
      this.pos = end;
      return;
    }
    let code = text.slice(end, closer).replace(/\n/g, ' ');
    // One space comes off each end when both have one, so `` ` `` can be written.
    if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') code = code.slice(1, -1);
    this.add(node('code', code));
    this.pos = closer + length;
  }

  private delimiterRun(char: string): void {
    const { text } = this;
    let end = this.pos;
    while (text[end] === char) end++;
    const length = end - this.pos;
    const before = text[this.pos - 1];
    const after = text[end];
    const leftFlanking = !isSpace(after) && (!isPunctuation(after) || isSpace(before) || isPunctuation(before));
    const rightFlanking = !isSpace(before) && (!isPunctuation(before) || isSpace(after) || isPunctuation(after));
    let canOpen = leftFlanking;
    let canClose = rightFlanking;
    if (char === '_') {
      canOpen = leftFlanking && (!rightFlanking || isPunctuation(before));
      canClose = rightFlanking && (!leftFlanking || isPunctuation(after));
    }
    // Strikethrough is ~~ only: a single ~, as in "~5 minutes", is text.
    if ((char === '~' && length !== 2) || (!canOpen && !canClose)) {
      this.buffer += text.slice(this.pos, end);
      this.pos = end;
      return;
    }
    const item = this.add(node('delim', char));
    item.count = length;
    const delimiter: Delimiter = { node: item, char, length, canOpen, canClose, prev: this.delimiters, next: null };
    if (this.delimiters) this.delimiters.next = delimiter;
    this.delimiters = delimiter;
    this.pos = end;
  }

  private openBracket(image: boolean): void {
    const item = this.add(node('text', image ? '![' : '['));
    this.brackets = { node: item, image, active: true, delimiter: this.delimiters, prev: this.brackets };
    this.pos += image ? 2 : 1;
  }

  private closeBracket(): void {
    const opener = this.brackets;
    if (!opener) {
      this.buffer += ']';
      this.pos += 1;
      return;
    }
    this.brackets = opener.prev;
    const target = opener.active ? linkTarget(this.text, this.pos + 1) : undefined;
    if (!target) {
      this.buffer += ']';
      this.pos += 1;
      return;
    }
    this.flush();
    const url = httpUrl(target.destination);
    if (!opener.image && !url) {
      // A link to anything else is the text it was written as, its target included, unparsed.
      this.buffer += this.text.slice(this.pos, target.end);
      this.pos = target.end;
      return;
    }
    this.matchEmphasis(opener.delimiter);
    const depth = 1 + depthBetween(opener.node, null);
    if (!opener.image && depth > MAX_INLINE_DEPTH) {
      this.deactivate(opener);
      this.buffer += this.text.slice(this.pos, target.end);
      this.pos = target.end;
      return;
    }
    if (url && depth <= MAX_INLINE_DEPTH) {
      const link = node('link');
      link.href = url.href;
      link.depth = depth;
      this.nodes.wrap(opener.node, null, link);
      // An image with no alt text shows its URL instead.
      if (!link.first) link.first = link.last = node('text', target.destination);
    } else if (opener.node.next === null) {
      // An image that isn't linked becomes its alt text alone, or its URL as written when it has none.
      this.buffer += target.destination;
    }
    this.nodes.remove(opener.node);
    // Links don't contain links: the brackets before this one can't make one now.
    if (!opener.image) this.deactivate(opener);
    this.pos = target.end;
  }

  /** The [ openers before `opener` can't start a link. Stops at one already done, so each is done once. */
  private deactivate(opener: Bracket): void {
    for (let at = opener.prev; at; at = at.prev) {
      if (at.image) continue;
      if (!at.active) break;
      at.active = false;
    }
  }

  /** `<https://…>`: a link when it's http: or https:, and otherwise the literal text it is. */
  private autolink(): void {
    const { text } = this;
    let j = this.pos + 1;
    const scheme = j;
    while (j < text.length && j - scheme <= 32 && /[A-Za-z0-9+.-]/.test(text[j] as string)) j++;
    if (j - scheme < 2 || text[j] !== ':' || !/[A-Za-z]/.test(text[scheme] as string)) {
      this.buffer += '<';
      this.pos += 1;
      return;
    }
    while (j < text.length && text[j] !== '>' && text[j] !== '<' && (text[j] as string) > ' ') j++;
    if (text[j] !== '>') {
      this.buffer += '<';
      this.pos += 1;
      return;
    }
    const written = text.slice(this.pos + 1, j);
    const url = httpUrl(written);
    if (!url) {
      this.buffer += text.slice(this.pos, j + 1);
    } else {
      const link = this.add(node('link'));
      link.href = url.href;
      link.depth = 1;
      link.first = link.last = node('text', written);
    }
    this.pos = j + 1;
  }

  /**
   * Matches emphasis among the delimiters after `bottom`, as CommonMark's "process emphasis" does,
   * then drops them: what's left of them is text.
   */
  private matchEmphasis(bottom: Delimiter | null): void {
    // How far back an opener was last looked for and not found, by character, whether the closer can
    // open, and its length mod 3: no later closer of the same kind looks past it again.
    const openersBottom = new Map<string, Delimiter | null>();
    let closer = bottom ? bottom.next : this.firstDelimiter();
    while (closer) {
      if (!closer.canClose) {
        closer = closer.next;
        continue;
      }
      const key = `${closer.char}${closer.canOpen ? 1 : 0}${closer.length % 3}`;
      const floor = openersBottom.has(key) ? (openersBottom.get(key) ?? null) : bottom;
      let opener = closer.prev;
      while (opener && opener !== bottom && opener !== floor && !this.opens(opener, closer)) opener = opener.prev;
      const found = opener && opener !== bottom && opener !== floor ? opener : null;
      const depth = found ? 1 + depthBetween(found.node, closer.node) : 0;
      if (!found || depth > MAX_INLINE_DEPTH) {
        // Nesting deeper than the limit counts as no opener: an earlier one would be deeper still.
        openersBottom.set(key, closer.prev);
        const next = closer.next;
        if (!closer.canOpen) this.removeDelimiter(closer);
        closer = next;
        continue;
      }
      const used = closer.char === '~' || (found.node.count >= 2 && closer.node.count >= 2) ? 2 : 1;
      const wrapper = node(closer.char === '~' ? 'del' : used === 2 ? 'strong' : 'em');
      wrapper.depth = depth;
      found.node.count -= used;
      closer.node.count -= used;
      this.nodes.wrap(found.node, closer.node, wrapper);
      // The delimiters between them are text now.
      found.next = closer;
      closer.prev = found;
      if (found.node.count === 0) {
        this.nodes.remove(found.node);
        this.removeDelimiter(found);
      }
      if (closer.node.count === 0) {
        const next = closer.next;
        this.nodes.remove(closer.node);
        this.removeDelimiter(closer);
        closer = next;
      }
    }
    // Every delimiter above the bottom is done with.
    while (this.delimiters && this.delimiters !== bottom) this.removeDelimiter(this.delimiters);
  }

  /** Whether `opener` can open what `closer` closes, with CommonMark's rule of three for * and _. */
  private opens(opener: Delimiter, closer: Delimiter): boolean {
    if (opener.char !== closer.char || !opener.canOpen) return false;
    if (closer.char === '~') return true;
    const both = opener.canClose || closer.canOpen;
    return !(both && (opener.length + closer.length) % 3 === 0 && !(opener.length % 3 === 0 && closer.length % 3 === 0));
  }

  private firstDelimiter(): Delimiter | null {
    let first = this.delimiters;
    while (first?.prev) first = first.prev;
    return first;
  }

  private removeDelimiter(delimiter: Delimiter): void {
    if (delimiter.prev) delimiter.prev.next = delimiter.next;
    if (delimiter.next) delimiter.next.prev = delimiter.prev;
    if (this.delimiters === delimiter) this.delimiters = delimiter.prev;
    delimiter.prev = delimiter.next = null;
  }
}

/**
 * A link's target after its `]`: `(destination "title")`, either part optional, as CommonMark has it.
 * The destination is `<…>` or has no spaces and balanced parentheses, at most 32 deep, so a scan stops
 * at the first space, or soon after a run of `(`.
 */
function linkTarget(text: string, at: number): { destination: string; end: number } | undefined {
  if (text[at] !== '(') return undefined;
  let i = skipSpace(text, at + 1);
  let destination = '';
  if (text[i] === '<') {
    let j = i + 1;
    while (j < text.length && text[j] !== '>' && text[j] !== '<' && text[j] !== '\n') {
      if (text[j] === '\\' && isAsciiPunctuation(text[j + 1])) j++;
      destination += text[j];
      j++;
    }
    if (text[j] !== '>') return undefined;
    i = j + 1;
  } else {
    let j = i;
    let depth = 0;
    while (j < text.length) {
      const c = text[j] as string;
      if (c === '\\' && isAsciiPunctuation(text[j + 1])) {
        destination += text[j + 1];
        j += 2;
        continue;
      }
      if (c === '(') {
        depth++;
        if (depth > 32) return undefined;
      } else if (c === ')') {
        if (depth === 0) break;
        depth--;
      } else if (c <= ' ') {
        break;
      }
      destination += c;
      j++;
    }
    if (depth !== 0) return undefined;
    i = j;
  }
  const afterDestination = i;
  i = skipSpace(text, i);
  const quote = text[i];
  if (i > afterDestination && (quote === '"' || quote === "'" || quote === '(')) {
    const close = quote === '(' ? ')' : quote;
    let j = i + 1;
    while (j < text.length && text[j] !== close) {
      if (quote === '(' && text[j] === '(') return undefined;
      j += text[j] === '\\' ? 2 : 1;
    }
    if (j >= text.length) return undefined;
    i = skipSpace(text, j + 1);
  }
  if (text[i] !== ')') return undefined;
  return { destination, end: i + 1 };
}

/** Past spaces and tabs, and one newline among them. */
function skipSpace(text: string, at: number): number {
  let i = at;
  let newline = false;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '\n') {
      if (newline) break;
      newline = true;
    } else if (c !== ' ' && c !== '\t') {
      break;
    }
  }
  return i;
}

/**
 * The nodes as the tree: delimiters left over are text, neighbouring text is joined, and bare URLs
 * in text and code outside a link become links. A link inside a link, as an image inside one is, gives
 * only its text, and code inside a link stays plain code, since links can't nest.
 */
function toInlines(first: Node | null, inLink: boolean): Inline[] {
  const out: Inline[] = [];
  const pushText = (text: string) => {
    if (text === '') return;
    const last = out[out.length - 1];
    if (last?.type === 'text') last.text += text;
    else out.push({ type: 'text', text });
  };
  for (let at = first; at; at = at.next) {
    switch (at.type) {
      case 'text':
        pushText(at.text);
        break;
      case 'delim':
        pushText(at.text.repeat(at.count));
        break;
      case 'code': {
        const linked = inLink ? undefined : linkedCode(at.text);
        out.push(linked ? { type: 'code', text: at.text, linked } : { type: 'code', text: at.text });
        break;
      }
      case 'break':
        out.push({ type: 'break' });
        break;
      case 'link':
        if (!inLink) {
          out.push({ type: 'link', href: at.href, children: toInlines(at.first, true) });
          break;
        }
        for (const child of toInlines(at.first, true)) {
          if (child.type === 'text') pushText(child.text);
          else out.push(child);
        }
        break;
      case 'strong':
      case 'em':
      case 'del':
        out.push({ type: at.type, children: toInlines(at.first, inLink) });
        break;
    }
  }
  return inLink ? out : out.flatMap((item) => (item.type === 'text' ? linkify(item.text) : [item]));
}

const BARE_URL = /https?:\/\//gi;
/** Characters a bare URL can't end with, as in GFM: they're the sentence's. */
const TRAILING = new Set(['?', '!', '.', ',', ':', ';', '*', '_', '~', "'", '"']);

/**
 * Text with its bare http: and https: URLs as links. A URL starts anywhere but straight after a letter
 * or a digit (GFM allows only a space, `*`, `_`, `~` or `(` before one; a quote or a bracket is allowed
 * here too), runs to a space or `<`, and loses trailing punctuation and closing parentheses or
 * brackets it doesn't open. One that the browser can't parse stays text, and the scan goes on after it.
 *
 * `within` is `code` for the text of a code span or block (W37): the same rule, except that a URL in
 * markdown's own link syntax stays text there, as the rest of code does: a link's target, `](url`, link
 * text that a target follows, `[url](…`, or an autolink, `<url>`.
 */
export function linkify(text: string, within: 'text' | 'code' = 'text'): Inline[] {
  if (!text.includes('://')) return [{ type: 'text', text }];
  const out: Inline[] = [];
  let copied = 0;
  BARE_URL.lastIndex = 0;
  for (let found = BARE_URL.exec(text); found; found = BARE_URL.exec(text)) {
    const start = found.index;
    const before = text[start - 1];
    if (before !== undefined && /[\p{L}\p{N}]/u.test(before)) continue;
    let end = start + found[0].length;
    while (end < text.length && !/[\s<]/.test(text[end] as string)) end++;
    const scanned = end;
    if (within === 'code' && inLinkSyntax(text, start, scanned)) {
      BARE_URL.lastIndex = scanned;
      continue;
    }
    end = trimmedEnd(text, start, end);
    const url = end > start + found[0].length ? httpUrl(text.slice(start, end)) : undefined;
    if (!url) {
      // The rest of this run isn't looked at again, so no run is scanned twice.
      BARE_URL.lastIndex = scanned;
      continue;
    }
    if (start > copied) out.push({ type: 'text', text: text.slice(copied, start) });
    out.push({ type: 'link', href: url.href, children: [{ type: 'text', text: text.slice(start, end) }] });
    copied = end;
    BARE_URL.lastIndex = end;
  }
  if (copied < text.length) out.push({ type: 'text', text: text.slice(copied) });
  return out;
}

/**
 * Whether the URL at `start`, whose run goes to `end`, is part of markdown's link syntax: a link's
 * target, `](url`; link text with a target after it, `url](…`; or an autolink, `<url>`. Only the run is
 * looked at, so each run is scanned once.
 */
function inLinkSyntax(text: string, start: number, end: number): boolean {
  if (text[start - 1] === '(' && text[start - 2] === ']') return true;
  const run = text.slice(start, end);
  return run.includes('](') || (text[start - 1] === '<' && run.includes('>'));
}

/**
 * Code's text with its bare http: and https: URLs as links, or undefined when it has none, so code
 * with no URL in it stays a single string (W37).
 */
function linkedCode(text: string): Inline[] | undefined {
  const linked = linkify(text, 'code');
  return linked.some((item) => item.type === 'link') ? linked : undefined;
}

/** Where a bare URL in text[start, end) really ends: without trailing punctuation, or a `)` or `]` it didn't open. */
function trimmedEnd(text: string, start: number, end: number): number {
  let opened = { ')': 0, ']': 0 };
  for (let i = start; i < end; i++) {
    const c = text[i];
    if (c === '(') opened[')']++;
    else if (c === ')') opened[')']--;
    else if (c === '[') opened[']']++;
    else if (c === ']') opened[']']--;
  }
  let at = end;
  while (at > start) {
    const c = text[at - 1] as string;
    if (TRAILING.has(c)) {
      at--;
    } else if ((c === ')' || c === ']') && opened[c] < 0) {
      opened = { ...opened, [c]: opened[c] + 1 };
      at--;
    } else {
      break;
    }
  }
  return at;
}
