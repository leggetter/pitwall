// WCAG 2.x contrast for the colour pairs in docs/design-system.md (2.5), against the values in
// tokens.css, in light and dark. Text needs 4.5:1; control edges, the focus ring and indicators need
// 3:1. Each pair is checked against every background it may sit on (2.1), and the test name shows the
// worst ratio and where. The only exemption is --pw-text-disabled, which WCAG 1.4.3 allows on
// inactive controls.
import { describe, expect, it } from 'vitest';
import { themeTokens } from './test/css.js';

type Theme = 'light' | 'dark';
const THEMES: Theme[] = ['light', 'dark'];
const TONES = ['neutral', 'info', 'success', 'warning', 'danger'] as const;

/** "Neutral surfaces" (2.5): where text and -fg tokens may sit. The overlay is the surface of dialogs, menus and tooltips. */
const NEUTRAL = [
  '--pw-bg',
  '--pw-surface',
  '--pw-surface-muted',
  '--pw-surface-sunken',
  '--pw-surface-hover',
  '--pw-surface-hover-bg',
  '--pw-surface-overlay',
  '--pw-selected',
];
const TINTS = TONES.map((tone) => `--pw-${tone}-tint`);
/** "Every surface and tint" (2.5): where --pw-text, -muted and -subtle may sit. */
const EVERY = [...NEUTRAL, '--pw-surface-strong', ...TINTS];

interface Pair {
  /** The colour drawn on top: text, an edge or an indicator. */
  fg: string;
  /** Every background it may be drawn on. */
  on: string[];
  min: 4.5 | 3;
}

const text = (fg: string, on: string[]): Pair => ({ fg, on, min: 4.5 });
const edge = (fg: string, on: string[]): Pair => ({ fg, on, min: 3 });

/** The pairs in 2.5, in its order. */
const PAIRS: Pair[] = [
  text('--pw-text', EVERY),
  text('--pw-text-muted', EVERY),
  text('--pw-text-subtle', EVERY),
  text('--pw-link', NEUTRAL),
  ...TONES.map((tone) => text(`--pw-${tone}-fg`, NEUTRAL)),
  ...TONES.map((tone) => text(`--pw-${tone}-tint-fg`, [`--pw-${tone}-tint`])),
  ...TONES.map((tone) => text(`--pw-on-${tone}-solid`, [`--pw-${tone}-solid`])),
  text('--pw-on-accent', ['--pw-accent', '--pw-accent-hover']),
  text('--pw-text', ['--pw-highlight']),
  // A pressed filter chip's label. --pw-selected has the info tint's value, but the pair is its own.
  text('--pw-info-tint-fg', ['--pw-selected']),
  text('--pw-text-inverse', ['--pw-text']),
  ...['boolean', 'string', 'number', 'null'].map((kind) => text(`--pw-code-${kind}`, ['--pw-surface', '--pw-surface-muted'])),
  text('--pw-term-fg', ['--pw-term-bg']),
  ...['red', 'green', 'yellow', 'blue'].map((colour) => text(`--pw-term-${colour}`, ['--pw-term-bg'])),
  edge('--pw-term-cursor', ['--pw-term-bg']),
  edge('--pw-border-control', ['--pw-surface', '--pw-bg', '--pw-surface-muted', '--pw-surface-sunken']),
  edge('--pw-border-input', ['--pw-surface', '--pw-bg', '--pw-surface-muted', '--pw-surface-sunken']),
  edge('--pw-focus', ['--pw-surface', '--pw-bg', '--pw-surface-muted', '--pw-surface-sunken', '--pw-surface-hover', '--pw-surface-hover-bg', '--pw-selected']),
  // The ring around a selected item, and a checked checkbox's fill, which can sit on any neutral surface.
  edge('--pw-selected-border', NEUTRAL),
  // The bar of a row that needs you, on the row as it is, hovered or open, and the restart confirmation's bar.
  edge('--pw-warning-indicator', ['--pw-surface', '--pw-bg', '--pw-surface-muted', '--pw-surface-hover', '--pw-selected']),
];

/**
 * pitwall's state aliases, as the components pair them. They resolve to tone tokens checked above;
 * these catch an alias pointed at the wrong one.
 */
const ALIAS_PAIRS: Pair[] = [
  ...['attention', 'asked', 'busy', 'idle', 'done', 'failed'].map((state) => text(`--pw-state-${state}-fg`, [`--pw-state-${state}-bg`])),
  text('--pw-state-offline-fg', NEUTRAL),
  // A row that needs you has no tint: the bar sits on the row as it is, hovered, or open.
  edge('--pw-state-attention-bar', ['--pw-surface', '--pw-surface-hover', '--pw-selected']),
  // The connection dots, and "Attached" in the terminal's bar, which is text.
  ...['--pw-live', '--pw-pending', '--pw-broken'].map((fg) => text(fg, NEUTRAL)),
];

/** Colours that are never checked, and why. */
const UNCHECKED: Record<string, string> = {
  '--pw-text-disabled': 'disabled controls only: WCAG 1.4.3 exempts inactive controls',
  '--pw-border': 'decorative: a divider',
  '--pw-border-strong': 'decorative: card edges',
  '--pw-border-dashed': 'decorative: not-running outlines',
  ...Object.fromEntries(TONES.map((tone) => [`--pw-${tone}-border`, 'decorative: the edge of a tinted container'])),
  '--pw-state-offline-border': 'decorative: --pw-border-dashed',
  ...Object.fromEntries(['asked', 'busy', 'idle', 'done', 'failed'].map((state) => [`--pw-state-${state}-border`, 'decorative: a tone -border'])),
  '--pw-backdrop': 'translucent, behind a dialog; nothing is drawn on it',
  '--pw-term-selection': "translucent: xterm.js draws the selected text's own colours over it",
};

interface Rgb {
  r: number;
  g: number;
  b: number;
  alpha: number;
}

/** #RGB, #RRGGBB or rgb(r g b / a), the notations tokens.css uses; undefined for anything else. */
function parseColour(value: string): Rgb | undefined {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex;
    const [r, g, b] = [0, 2, 4].map((at) => Number.parseInt(full.slice(at, at + 2), 16)) as [number, number, number];
    return { r, g, b, alpha: 1 };
  }
  const rgb = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+)\s*)?\)$/.exec(value);
  if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), alpha: rgb[4] === undefined ? 1 : Number(rgb[4]) };
  return undefined;
}

/** A token's value with var() followed, when the whole value is one var(). */
function resolve(values: Map<string, string>, name: string, seen: string[] = []): string {
  if (seen.includes(name)) throw new Error(`a var() loop: ${[...seen, name].join(' -> ')}`);
  const value = values.get(name);
  if (value === undefined) throw new Error(`${name} isn't defined`);
  const target = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
  return target ? resolve(values, target, [...seen, name]) : value;
}

function colour(values: Map<string, string>, name: string): Rgb {
  const value = resolve(values, name);
  const parsed = parseColour(value);
  if (!parsed) throw new Error(`${name} is ${value}, not a colour this test reads`);
  if (parsed.alpha !== 1) throw new Error(`${name} is translucent (${value}), so its contrast depends on what's behind it`);
  return parsed;
}

/** WCAG 2.x relative luminance. */
function luminance({ r, g, b }: Rgb): number {
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

interface Result {
  pair: Pair;
  ratio: number;
  worst: string;
}

/** A pair's worst ratio in a theme, and the background it's worst on. */
function check(theme: Theme, pair: Pair): Result {
  const values = themeTokens(theme);
  const fg = colour(values, pair.fg);
  const [worst] = pair.on.map((bg) => ({ bg, ratio: contrast(fg, colour(values, bg)) })).sort((x, y) => x.ratio - y.ratio);
  if (!worst) throw new Error(`${pair.fg} has no backgrounds`);
  return { pair, ratio: worst.ratio, worst: worst.bg };
}

const named = (results: Result[]) =>
  results.map((result) => {
    const where = result.pair.on.length > 1 ? ` (worst on ${result.worst})` : ` on ${result.worst}`;
    return [`${result.pair.fg}${where}: ${result.ratio.toFixed(2)}:1, needs ${result.pair.min}:1`, result] as const;
  });

describe.each(THEMES)('contrast in %s', (theme) => {
  it.each(named(PAIRS.map((pair) => check(theme, pair))))('%s', (_name, { pair, ratio }) => {
    expect(ratio).toBeGreaterThanOrEqual(pair.min);
  });

  it.each(named(ALIAS_PAIRS.map((pair) => check(theme, pair))))('state alias %s', (_name, { pair, ratio }) => {
    expect(ratio).toBeGreaterThanOrEqual(pair.min);
  });

  it('checks every colour token, or says why not', () => {
    const values = themeTokens(theme);
    const colours = [...values.keys()].filter((name) => parseColour(resolve(values, name)) !== undefined);
    const checked = new Set([...PAIRS, ...ALIAS_PAIRS].flatMap((pair) => [pair.fg, ...pair.on]));
    expect(colours.filter((name) => !checked.has(name) && !(name in UNCHECKED))).toEqual([]);
    // And the list of exemptions holds only real colour tokens, so it can't go stale.
    expect(Object.keys(UNCHECKED).filter((name) => !colours.includes(name))).toEqual([]);
  });

  it('leaves --pw-text-disabled below 4.5:1, so it stays the one exemption and is never used for content', () => {
    const values = themeTokens(theme);
    const ratio = contrast(colour(values, '--pw-text-disabled'), colour(values, '--pw-surface'));
    expect(ratio).toBeLessThan(4.5);
  });
});

describe('the contrast arithmetic', () => {
  it('matches WCAG at the extremes and for a known pair', () => {
    const black = { r: 0, g: 0, b: 0, alpha: 1 };
    const white = { r: 255, g: 255, b: 255, alpha: 1 };
    expect(contrast(black, white)).toBeCloseTo(21, 5);
    expect(contrast(white, white)).toBe(1);
    // #767676 on white is the classic 4.54:1.
    expect(contrast({ r: 0x76, g: 0x76, b: 0x76, alpha: 1 }, white)).toBeCloseTo(4.54, 2);
  });

  it('reads the notations tokens.css uses', () => {
    expect(parseColour('#FFF')).toEqual({ r: 255, g: 255, b: 255, alpha: 1 });
    expect(parseColour('#0044CC')).toEqual({ r: 0, g: 68, b: 204, alpha: 1 });
    expect(parseColour('rgb(0 0 0 / 0.1)')).toEqual({ r: 0, g: 0, b: 0, alpha: 0.1 });
    expect(parseColour('var(--pw-surface)')).toBeUndefined();
  });
});
