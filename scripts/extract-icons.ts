// Writes web/src/icons/paths.ts: the SVG path data for the Material Symbols
// glyphs pitwall uses, keyed by the semantic names in docs/design-system.md
// (2.14), with one path for each size the Icon component draws. It also copies
// the licence to web/src/icons/LICENSE. The glyphs come from
// google/material-design-icons at a pinned commit, fetched file by file: only
// the files below, never the whole repository, and nothing is installed.
//
//   mkdir <new empty dir>
//   npx tsx scripts/extract-icons.ts curl-config > <a file outside that dir>
//   curl -fsS --create-dirs --output-dir <that dir> -K <that file>
//   npx tsx scripts/extract-icons.ts <that dir>
//
// The fetched files are read as text and nothing in them is run. Each SVG must
// be a single path in Material Symbols' 960-unit viewBox, and each path may
// contain only path commands and numbers, so nothing else can reach the
// generated file.
//
// Every glyph is fill 0, except a name that asks for the filled style (fill1),
// which Material Symbols draws for a toggle that's on: the starred star (W53).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'google/material-design-icons';
/** 2026-10-02, "Update Symbols". Apache License 2.0 at this commit, with no NOTICE file. */
const COMMIT = '737e3324305806514d7909874fa1818ae1808232';
/** Rounded, fill 0, weight 400, grade 0: the files with nothing between the glyph and the optical size. */
const STYLE = 'materialsymbolsrounded';
/** The one other style a name may ask for: fill 1, for a toggle that's on, with weight and grade as above. */
const FILLED = 'fill1';
const VIEW_BOX = '0 -960 960 960';

/**
 * The size Icon draws, then the optical size drawn at it. Material Symbols adjusts stroke widths
 * for each optical size: the 20 px design keeps its strokes legible at 16 px, where the 48 px one
 * looks thin. There is no 16 px optical size.
 */
const SIZES = [
  [16, 20],
  [24, 24],
] as const;

/**
 * Semantic name, then the Material Symbols glyph it uses, or the glyph and its filled style. The table
 * in docs/design-system.md, 2.14.
 */
const ICONS: Readonly<Record<string, string | readonly [glyph: string, style: typeof FILLED]>> = {
  close: 'close',
  expand: 'chevron_right',
  // The down chevron, which Material Symbols used to call expand_more.
  select: 'keyboard_arrow_down',
  more: 'more_horiz',
  menu: 'menu',
  search: 'search',
  clear: 'cancel',
  add: 'add',
  copy: 'content_copy',
  copied: 'check',
  terminal: 'terminal',
  conversation: 'forum',
  send: 'send',
  stop: 'stop_circle',
  remove: 'delete',
  restart: 'restart_alt',
  retry: 'refresh',
  info: 'info',
  success: 'check_circle',
  warning: 'warning',
  error: 'error',
  // A branch: it reads as git at 16 px, as today's inline icon does. account_tree reads as a hierarchy.
  repo: 'graph_1',
  directory: 'folder',
  external: 'open_in_new',
  latest: 'arrow_downward',
  back: 'arrow_back',
  keyboard: 'keyboard',
  // Hide from the repo list, and show in it again (W35).
  hide: 'visibility_off',
  show: 'visibility',
  // The header's View preferences menu, and the mark on its chosen option (W42).
  preferences: 'tune',
  checked: 'check',
  // A session's star, off and on (W53): the same glyph, outlined, then filled, as Material Symbols draws a toggle's two states.
  star: 'star',
  starred: ['star', FILLED],
  // The session view's Sub-agents tab (W77): a session and the sub-agents it started, some of them by another.
  subagents: 'account_tree',
  // New session's Attach files (W82), and the type of each file in its list: an image, a PDF, or text.
  attach: 'attach_file',
  image: 'image',
  pdf: 'picture_as_pdf',
  file: 'description',
  'theme-system': 'computer',
  'theme-light': 'light_mode',
  'theme-dark': 'dark_mode',
};

const OUTPUT = fileURLToPath(new URL('../web/src/icons/paths.ts', import.meta.url));
const LICENSE_OUTPUT = fileURLToPath(new URL('../web/src/icons/LICENSE', import.meta.url));

function fail(message: string): never {
  console.error(`extract-icons: ${message}`);
  process.exit(1);
}

/** A name's glyph, and its style when it isn't fill 0. */
function glyphOf(entry: (typeof ICONS)[string]): { glyph: string; style: string | undefined } {
  return typeof entry === 'string' ? { glyph: entry, style: undefined } : { glyph: entry[0], style: entry[1] };
}

/** A glyph's file name, for one optical size: star_20px, or star_fill1_20px for the filled style. */
function fileName(entry: (typeof ICONS)[string], opticalSize: number): string {
  const { glyph, style } = glyphOf(entry);
  return `${glyph}${style ? `_${style}` : ''}_${opticalSize}px`;
}

/** Where a glyph's file is in the repository, for one optical size. */
function glyphPath(entry: (typeof ICONS)[string], opticalSize: number): string {
  return `symbols/web/${glyphOf(entry).glyph}/${STYLE}/${fileName(entry, opticalSize)}.svg`;
}

/** Every file the extraction reads, relative to the repository root. */
function files(): string[] {
  return ['LICENSE', ...Object.values(ICONS).flatMap((entry) => SIZES.map(([, optical]) => glyphPath(entry, optical)))];
}

/** The one path's `d`, after checking the SVG is the shape the generated file assumes. */
function pathData(svg: string, file: string): string {
  const root = /^\s*<svg\b([^>]*)>([\s\S]*)<\/svg>\s*$/.exec(svg);
  if (!root) fail(`${file} isn't a single <svg> element`);
  const [, attributes = '', body = ''] = root;
  const viewBox = /\bviewBox="([^"]*)"/.exec(attributes)?.[1];
  if (viewBox !== VIEW_BOX) fail(`${file} has viewBox "${viewBox ?? ''}", not "${VIEW_BOX}"`);
  const path = /^\s*<path d="([^"]*)"\s*\/>\s*$/.exec(body);
  if (!path) fail(`${file} isn't exactly one <path d="…"/> with no other attributes`);
  const d = path[1] ?? '';
  if (!/^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/.test(d)) fail(`${file} has characters in its path data that aren't path commands or numbers`);
  return d;
}

for (const [name, entry] of Object.entries(ICONS)) {
  const { glyph, style } = glyphOf(entry);
  if (!/^[a-z0-9_]+$/.test(glyph) || !/^[a-z]+(?:-[a-z]+)*$/.test(name) || (style !== undefined && style !== FILLED)) fail(`bad icon ${name}: ${glyph}`);
}

const [command] = process.argv.slice(2);
if (!command || process.argv.length > 3) fail('usage: npx tsx scripts/extract-icons.ts curl-config | <directory the files were fetched into>');

if (command === 'curl-config') {
  // A curl config file (curl -K): each file at the pinned commit, saved under its path in the repository.
  const base = `https://raw.githubusercontent.com/${REPO}/${COMMIT}`;
  console.log(files().map((file) => `url = "${base}/${file}"\noutput = "${file}"`).join('\n'));
  process.exit(0);
}

const dir = command;
const licence = readFileSync(join(dir, 'LICENSE'), 'utf8');
if (!licence.includes('Apache License') || !licence.includes('Version 2.0, January 2004') || !licence.includes('END OF TERMS AND CONDITIONS')) {
  fail(`${join(dir, 'LICENSE')} isn't the Apache License 2.0`);
}

const entries = Object.entries(ICONS).map(([name, entry]) => {
  const sizes = SIZES.map(([size, optical]) => {
    const file = join(dir, glyphPath(entry, optical));
    return `    /** ${fileName(entry, optical)} */\n    ${size}: '${pathData(readFileSync(file, 'utf8'), file)}',`;
  });
  // Single quotes, as in the rest of the code. Neither a name nor a checked path can contain one.
  const key = name.includes('-') ? `'${name}'` : name;
  return `  ${key}: {\n${sizes.join('\n')}\n  },`;
});

const source = `// Generated by scripts/extract-icons.ts. Don't edit by hand: see that script to regenerate it.
//
// Material Symbols Rounded, from ${REPO} at commit
// ${COMMIT} (Apache License 2.0; see ./LICENSE
// and THIRD_PARTY_NOTICES.md): fill 0, weight 400, grade 0, except the files
// named _${FILLED}_, which are fill 1, for a toggle that's on. Keyed by the
// semantic names in docs/design-system.md (2.14), then by the size Icon draws:
// 16 px uses the 20 px optical size, whose strokes hold up when scaled down,
// and 24 px uses the 24 px one. Each path's source file is named above it.
// Each path is in the ${VIEW_BOX} viewBox.

export const ICON_PATHS = {
${entries.join('\n')}
} as const;

export type IconName = keyof typeof ICON_PATHS;

/** The sizes Icon draws, in px: --pw-icon-sm and --pw-icon-lg. */
export type IconSize = ${SIZES.map(([size]) => size).join(' | ')};
`;

writeFileSync(OUTPUT, source);
// The repository's copy has no newline at the end; the text is otherwise unchanged.
writeFileSync(LICENSE_OUTPUT, `${licence.trimEnd()}\n`);
console.log(`extract-icons: wrote ${entries.length} icons at ${SIZES.length} sizes from ${REPO}@${COMMIT.slice(0, 7)} to ${OUTPUT}, and the licence to ${LICENSE_OUTPUT}`);
