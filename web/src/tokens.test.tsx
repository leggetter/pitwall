// tokens.css and the stylesheets that use it, read as text (docs/design-system.md, 2.1 and 2.2).
import { describe, expect, it } from 'vitest';
import { darkBlock, defaultBlocks, systemDarkBlock, tokens, withoutComments } from './test/css.js';

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

  it('points every state alias at a token, never at a colour of its own', () => {
    const aliases = defaultBlocks.filter(([property]) => /^--pw-(?:state-|live$|pending$|broken$)/.test(property));
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
