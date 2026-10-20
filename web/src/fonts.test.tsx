// fonts.css against docs/design-system.md (2.14) and against the @fontsource packages it bundles from.
import inter400 from '@fontsource/inter/400.css?raw';
import inter500 from '@fontsource/inter/500.css?raw';
import inter600 from '@fontsource/inter/600.css?raw';
import mono400 from '@fontsource/jetbrains-mono/400.css?raw';
import mono500 from '@fontsource/jetbrains-mono/500.css?raw';
import { describe, expect, it } from 'vitest';
import fontsCss from './fonts.css?raw';

interface Face {
  family: string;
  weight: string;
  style: string;
  display: string | undefined;
  src: string;
  unicodeRange: string | undefined;
}

function faces(css: string): Face[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/@font-face\s*\{([^}]*)\}/g)].map((match) => {
    const get = (property: string) => new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`).exec(match[1] ?? '')?.[1]?.trim();
    return {
      family: (get('font-family') ?? '').replace(/^'|'$/g, ''),
      weight: get('font-weight') ?? '',
      style: get('font-style') ?? '',
      display: get('font-display'),
      src: get('src') ?? '',
      unicodeRange: get('unicode-range'),
    };
  });
}

/** The package's own unicode-range for each of its files, by file name. */
const packageRanges = new Map(
  [inter400, inter500, inter600, mono400, mono500].flatMap(faces).map((face) => {
    const file = /url\(\.\/files\/([\w-]+)\.woff2\)/.exec(face.src)?.[1];
    return [file, face.unicodeRange?.replace(/\s+/g, '')] as const;
  }),
);

const declared = faces(fontsCss);

describe('fonts.css', () => {
  it('declares Inter 400, 500 and 600, and JetBrains Mono 400 and 500, in Latin and Latin Extended only', () => {
    const files = declared.map((face) => /\/files\/([\w-]+)\.woff2'\)/.exec(face.src)?.[1]).sort();
    expect(files).toEqual(
      [
        ...['400', '500', '600'].flatMap((weight) => [`inter-latin-${weight}-normal`, `inter-latin-ext-${weight}-normal`]),
        ...['400', '500'].flatMap((weight) => [`jetbrains-mono-latin-${weight}-normal`, `jetbrains-mono-latin-ext-${weight}-normal`]),
      ].sort(),
    );
  });

  it.each(declared)('$family $weight: woff2 only, from its package, normal, swap', (face) => {
    const pkg = face.family === 'Inter' ? 'inter' : face.family === 'JetBrains Mono' ? 'jetbrains-mono' : undefined;
    expect(pkg).toBeDefined();
    expect(face.src).toMatch(new RegExp(`^url\\('@fontsource/${pkg}/files/${pkg}-latin(?:-ext)?-${face.weight}-normal\\.woff2'\\) format\\('woff2'\\)$`));
    expect(face.style).toBe('normal');
    expect(face.display).toBe('swap');
  });

  it.each(declared)("$family $weight: each subset's unicode-range is the package's", (face) => {
    const file = /\/files\/([\w-]+)\.woff2'\)/.exec(face.src)?.[1];
    expect(packageRanges.get(file)).toBeDefined();
    expect(face.unicodeRange?.replace(/\s+/g, '')).toBe(packageRanges.get(file));
  });
});
