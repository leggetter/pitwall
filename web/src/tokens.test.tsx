// tokens.css and the stylesheets that use it, read as text (docs/design-system.md, 2.1 and 2.2).
import { describe, expect, it } from 'vitest';
import tokensCss from './tokens.css?raw';

/** Every stylesheet under web/src, by path, as text. */
const stylesheets = import.meta.glob<string>('./**/*.css', { query: '?raw', import: 'default', eager: true });
const others = Object.entries(stylesheets).filter(([path]) => path !== './tokens.css');

function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The body of every block that `start` opens, which must end in `{`, found by matching braces. */
function blocks(css: string, start: RegExp): string[] {
  return [...css.matchAll(new RegExp(start.source, 'g'))].map((match) => {
    const open = (match.index ?? 0) + match[0].length - 1;
    expect(css[open]).toBe('{');
    let depth = 0;
    for (let index = open; index < css.length; index += 1) {
      if (css[index] === '{') depth += 1;
      else if (css[index] === '}') {
        depth -= 1;
        if (depth === 0) return css.slice(open + 1, index);
      }
    }
    throw new Error(`unclosed block after ${start.source}`);
  });
}

/** The body of the one block that `start` opens. Fails if there isn't exactly one. */
function block(css: string, start: RegExp): string {
  const found = blocks(css, start);
  expect(found, `exactly one ${start.source}`).toHaveLength(1);
  return found[0] ?? '';
}

/** A block's declarations in order, as [property, value], with whitespace collapsed. */
function declarations(body: string): [string, string][] {
  return body
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const colon = part.indexOf(':');
      expect(colon, `a declaration: ${part}`).toBeGreaterThan(0);
      return [part.slice(0, colon).trim(), part.slice(colon + 1).replace(/\s+/g, ' ').trim()];
    });
}

const tokens = withoutComments(tokensCss);
const darkBlock = declarations(block(tokens, /:root\[data-theme='dark'\]\s*\{/));
const mediaBlock = block(tokens, /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{/);
const systemDarkBlock = declarations(block(mediaBlock, /:root:not\(\[data-theme\]\)\s*\{/));
/** The plain `:root { … }` blocks: the structure tokens and the light values, which are the default. */
const defaultBlocks = blocks(tokens, /(?:^|\})\s*:root\s*\{/).flatMap(declarations);
const definedByDefault = new Set(defaultBlocks.map(([property]) => property));
/** Every --pw-* custom property tokens.css defines, in any block. */
const defined = new Set([...tokens.matchAll(/(--pw-[\w-]+)\s*:/g)].map((match) => match[1]));

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
});

describe('the stylesheets that use tokens.css', () => {
  it('are found', () => {
    expect(others.map(([path]) => path)).toEqual(expect.arrayContaining(['./styles.css', './relay.css', './actions.css', './components/Terminal.css']));
  });

  it.each(others)('%s uses only custom properties that tokens.css defines', (_path, css) => {
    const used = [...withoutComments(css).matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]);
    expect(used.filter((name) => !defined.has(name))).toEqual([]);
  });

  it.each(others)("%s doesn't define custom properties of its own", (_path, css) => {
    expect(withoutComments(css).match(/(?:^|[{;\s])--[\w-]+\s*:/g) ?? []).toEqual([]);
  });

  it.each(others)('%s has no colour values of its own: they come from tokens', (_path, css) => {
    expect(withoutComments(css).match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/gi) ?? []).toEqual([]);
  });
});
