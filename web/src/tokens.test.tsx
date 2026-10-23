// tokens.css and the stylesheets that use it, read as text (docs/design-system.md, 2.1 and 2.2).
import { describe, expect, it } from 'vitest';
import designSystem from '../../docs/design-system.md?raw';
import indexHtml from '../index.html?raw';
import { block, darkBlock, declarations, defaultBlocks, systemDarkBlock, tokens, withoutComments } from './test/css.js';

/** Every stylesheet under web/src, by path, as text. */
const stylesheets = import.meta.glob<string>('./**/*.css', { query: '?raw', import: 'default', eager: true });
const others = Object.entries(stylesheets).filter(([path]) => path !== './tokens.css');
/** The components and the gallery, which name tokens in inline styles. */
const sources = Object.entries(import.meta.glob<string>(['./**/*.tsx', '!./**/*.test.tsx'], { query: '?raw', import: 'default', eager: true }));

const definedByDefault = new Set(defaultBlocks.map(([property]) => property));
/** Every --pw-* custom property tokens.css defines, in any block. */
const defined = new Set([...tokens.matchAll(/(--pw-[\w-]+)\s*:/g)].map((match) => match[1]));

const varsIn = (text: string) => [...text.matchAll(/var\(\s*(--[\w-]+)/g)].flatMap((match) => (match[1] ? [match[1]] : []));

describe('tokens.css', () => {
  it('has the same dark values for data-theme="dark" and for a dark system with no data-theme', () => {
    expect(darkBlock.length).toBeGreaterThan(0);
    expect(systemDarkBlock).toEqual(darkBlock);
  });

  it('sets color-scheme in the light and dark blocks, so native controls and scrollbars match', () => {
    expect(defaultBlocks).toContainEqual(['color-scheme', 'light']);
    expect(darkBlock).toContainEqual(['color-scheme', 'dark']);
  });

  it('gives every dark token a light value too, so nothing is dark-only', () => {
    expect(darkBlock.map(([property]) => property).filter((property) => !definedByDefault.has(property))).toEqual([]);
  });

  it('only refers to tokens it defines, such as the colours inside the shadows and the state aliases', () => {
    expect(varsIn(tokens).filter((name) => !defined.has(name))).toEqual([]);
  });

  it('is the token file in docs/design-system.md 2.6, apart from comments and the copy of the dark block', () => {
    const section = designSystem.slice(designSystem.indexOf('### 2.6 The token file'), designSystem.indexOf('### 2.7 Type'));
    const documented = /```css\n([\s\S]*?)\n```/.exec(section)?.[1];
    expect(documented).toBeDefined();
    const media = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{/;
    const copy = `@media (prefers-color-scheme: dark) {${block(tokens, media)}}`;
    expect(tokens).toContain(copy);
    const normalise = (css: string) => withoutComments(css).replace(/\s+/g, ' ').trim();
    expect(normalise(tokens.replace(copy, ''))).toBe(normalise(documented ?? ''));
  });

  it('points every state alias at a token, never at a colour of its own', () => {
    const aliases = defaultBlocks.filter(([property]) => /^--pw-state-/.test(property));
    expect(aliases.length).toBeGreaterThan(0);
    expect(aliases.filter(([, value]) => !/^var\(--pw-[\w-]+\)$/.test(value))).toEqual([]);
    // The aliases are the same in both themes: the tone tokens they point at change instead.
    expect(darkBlock.filter(([property]) => property.startsWith('--pw-state-'))).toEqual([]);
  });
});

describe('the stylesheets that use tokens.css', () => {
  it('are found', () => {
    expect(others.map(([path]) => path)).toEqual(expect.arrayContaining(['./styles.css', './relay.css', './actions.css', './components/Terminal.css']));
  });

  it.each(others)('%s uses only custom properties that tokens.css defines', (_path, css) => {
    expect(varsIn(withoutComments(css)).filter((name) => !defined.has(name))).toEqual([]);
  });

  it.each(others)("%s doesn't define custom properties of its own", (_path, css) => {
    expect(withoutComments(css).match(/(?:^|[{;\s])--[\w-]+\s*:/g) ?? []).toEqual([]);
  });

  it.each(others)('%s has no colour values of its own: they come from tokens', (_path, css) => {
    expect(withoutComments(css).match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/gi) ?? []).toEqual([]);
  });
});

describe('the components', () => {
  it('are found', () => {
    expect(sources.map(([path]) => path)).toEqual(expect.arrayContaining(['./components/Dashboard.tsx', './uikit/foundations.tsx']));
  });

  it.each(sources)('%s names only tokens that tokens.css defines', (_path, source) => {
    expect(varsIn(source).filter((name) => name.startsWith('--pw-') && !defined.has(name))).toEqual([]);
  });
});

describe('sizes that have a token (W31)', () => {
  const css = (path: string) => withoutComments(stylesheets[path] ?? '');
  const rule = (path: string, selector: RegExp) => Object.fromEntries(declarations(block(css(path), selector)));

  it('use it, not the raw px', () => {
    expect(rule('./styles.css', /\n\.menu\s*\{/)['min-width']).toBe('var(--pw-menu-min-w)');
    expect(rule('./styles.css', /\n\.empty-state\s*\{/)['max-width']).toBe('var(--pw-dialog-sm)');
    const checkbox = rule('./actions.css', /\n\.checkbox input\s*\{/);
    expect([checkbox.width, checkbox.height]).toEqual(['var(--pw-icon-sm)', 'var(--pw-icon-sm)']);
    expect(rule('./actions.css', /\n\.session-actions\s*\{/).gap).toBe('var(--pw-space-2)');
    expect(rule('./components/ShortcutsDialog.css', /\n\.shortcuts-switch \.field-hint\s*\{/)['padding-left']).toBe('calc(var(--pw-icon-sm) + var(--pw-space-1-5))');
  });
});

describe('every token', () => {
  /** The code that reads a token by name rather than with var(), such as a delay or the terminal's colours, without its comments. */
  const code = Object.entries(import.meta.glob<string>(['./**/*.ts', './**/*.tsx', '!./**/*.test.tsx', '!./test/**'], { query: '?raw', import: 'default', eager: true }));
  const noComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

  /** Tokens that belong to a set the doc keeps whole (2.4, 2.6), whether or not each step is used yet. */
  const SETS: [RegExp, string][] = [
    [/^--pw-space-/, 'the 4 px spacing scale'],
    [/^--pw-icon-/, 'the icon sizes'],
    [/^--pw-(?:on-)?(?:neutral|info|success|warning|danger)-/, 'the five tones, six tokens each'],
    [/^--pw-code-/, "the code palette, for code blocks (2.4)"],
  ];
  /** Mirrored by a constant in code rather than read by name, and why. */
  const MIRRORED: Record<string, string> = { '--pw-panel-min-w': "panelWidth.ts's PANEL_MIN, which the divider and the menu clamp to" };

  it('is used, by a stylesheet, another token or the code that reads it, unless it belongs to a set or is mirrored in code (W31)', () => {
    const used = new Set([
      ...varsIn(withoutComments(tokens.replace(/(--pw-[\w-]+)\s*:/g, ''))),
      ...others.flatMap(([, css]) => varsIn(withoutComments(css))),
      ...code.flatMap(([, source]) => [...noComments(source).matchAll(/--pw-[\w-]+/g)].map((match) => match[0])),
    ]);
    const unused = [...defined].filter((name): name is string => name !== undefined && !used.has(name));
    expect(unused.filter((name) => !SETS.some(([set]) => set.test(name)) && !(name in MIRRORED))).toEqual([]);
    // And nothing is excused that's in use after all.
    expect(Object.keys(MIRRORED).filter((name) => used.has(name))).toEqual([]);
  });
});

describe('the favicon in index.html', () => {
  /** The favicon's SVG, decoded from its data: URL. */
  const icon = decodeURIComponent(/<link\s+rel="icon"\s+href="data:image\/svg\+xml,([^"]+)"/.exec(indexHtml)?.[1] ?? '');
  const light = new Map(defaultBlocks);

  it('is drawn in the palette: the warning fill and the text that goes on it, as the light theme has them', () => {
    expect(icon).toContain('<svg');
    const colours = [...icon.matchAll(/(fill|stroke)='(#[0-9a-f]{3,8})'/gi)].map(([, attribute, value]) => [attribute, value?.toUpperCase()]);
    expect(colours).toEqual([
      ['fill', light.get('--pw-warning-solid')],
      ['stroke', light.get('--pw-on-warning-solid')],
    ]);
  });
});
