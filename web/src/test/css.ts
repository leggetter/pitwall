// Reads tokens.css and the stylesheets as text, for the token and contrast tests. Just enough of a
// CSS parser for pitwall's own stylesheets: comments, nested blocks found by matching braces, and
// declarations split on semicolons (none of pitwall's values contains one).

import { expect } from 'vitest';
import tokensCss from '../tokens.css?raw';

export function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The body of every block that `start` opens, which must end in `{`, found by matching braces. */
export function blocks(css: string, start: RegExp): string[] {
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
export function block(css: string, start: RegExp): string {
  const found = blocks(css, start);
  expect(found, `exactly one ${start.source}`).toHaveLength(1);
  return found[0] ?? '';
}

/** A block's declarations in order, as [property, value], with whitespace collapsed. */
export function declarations(body: string): [string, string][] {
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

export const tokens = withoutComments(tokensCss);

/** The `:root[data-theme='dark']` block's declarations. */
export const darkBlock = declarations(block(tokens, /:root\[data-theme='dark'\]\s*\{/));

/** The no-JavaScript copy: `:root:not([data-theme])` inside `@media (prefers-color-scheme: dark)`. */
export const systemDarkBlock = declarations(
  block(block(tokens, /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{/), /:root:not\(\[data-theme\]\)\s*\{/),
);

/**
 * The top-level `:root { … }` blocks, in order: the structure tokens, the light values (the
 * default) and the state aliases. Blocks inside an @media aren't top-level, so they're left out.
 */
export const defaultBlocks = blocks(tokens, /(?:^|\})\s*:root\s*\{/).flatMap(declarations);

/** Every custom property and its declared value as a theme has them: the defaults, then dark's overrides. */
export function themeTokens(theme: 'light' | 'dark'): Map<string, string> {
  const values = new Map<string, string>();
  for (const [property, value] of [...defaultBlocks, ...(theme === 'dark' ? darkBlock : [])]) {
    if (property.startsWith('--')) values.set(property, value);
  }
  return values;
}
