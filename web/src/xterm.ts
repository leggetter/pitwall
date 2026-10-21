// The real terminal: xterm.js with the fit addon. Loaded with import() on the
// first attach, so the dashboard doesn't download it until it's needed.
//
// Its look comes from the tokens (docs/design-system.md, 4: Terminal): the
// font family from --pw-font-mono and the colours from the --pw-term-* tokens,
// read with getComputedStyle when a terminal is created. Nothing here names a
// colour or a font, so the tokens are the one place to change them.

import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { TerminalHandle } from './components/Terminal.js';
import { terminalLinkHandler } from './links.js';

/** xterm.js theme keys, and the custom properties in tokens.css they come from. xterm.js's defaults cover the rest. */
export const THEME_TOKENS = [
  ['background', '--pw-term-bg'],
  ['foreground', '--pw-term-fg'],
  ['cursor', '--pw-term-cursor'],
  ['selectionBackground', '--pw-term-selection'],
  ['red', '--pw-term-red'],
  ['green', '--pw-term-green'],
  ['yellow', '--pw-term-yellow'],
  ['blue', '--pw-term-blue'],
] as const satisfies readonly (readonly [keyof ITheme, string])[];

/** The terminal's text size, in px (4: Terminal). */
export const TERMINAL_FONT_SIZE = 13;

/**
 * The longest the terminal waits for its font before it opens anyway. pitwall serves the font
 * itself, so it normally arrives in milliseconds; this only keeps a stalled request from leaving the
 * Terminal tab empty.
 */
export const FONT_WAIT_MS = 3000;

/**
 * The terminal's colours, read from the --pw-term-* tokens when a terminal is
 * created. A token that isn't set is left out, so xterm.js uses its default.
 */
export function terminalTheme(root: Element = document.documentElement): ITheme {
  const style = getComputedStyle(root);
  const theme: ITheme = {};
  for (const [key, token] of THEME_TOKENS) {
    const value = style.getPropertyValue(token).trim();
    if (value !== '') theme[key] = value;
  }
  return theme;
}

/** The terminal's font family, --pw-font-mono, or undefined when it isn't set, so xterm.js uses its default. */
export function terminalFontFamily(root: Element = document.documentElement): string | undefined {
  const value = getComputedStyle(root).getPropertyValue('--pw-font-mono').trim();
  return value === '' ? undefined : value;
}

/** What waitForFont() needs from document.fonts. */
export type FontLoader = Pick<FontFaceSet, 'load'>;

const documentFonts = (): FontLoader | undefined => (typeof document === 'undefined' ? undefined : document.fonts);

/**
 * Loads the family's regular and medium faces: true once both have, false when either can't, or
 * there's no family or no document.fonts. Never rejects. A family list loads only the families that
 * have an @font-face (fonts.css); the fallbacks after them are ignored.
 */
export function loadFont(family: string | undefined, fonts: FontLoader | undefined = documentFonts()): Promise<boolean> {
  if (family === undefined || fonts === undefined) return Promise.resolve(false);
  // A load that fails, even after the wait is over, settles quietly.
  return Promise.resolve()
    .then(() => Promise.all([400, 500].map((weight) => fonts.load(`${weight} ${TERMINAL_FONT_SIZE}px ${family}`))))
    .then(
      () => true,
      () => false,
    );
}

/** Whether `promise` settles within `timeout` ms. */
async function settlesWithin(promise: Promise<unknown>, timeout: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), timeout)))]);
  clearTimeout(timer);
  return settled;
}

/**
 * Waits until the family's regular and medium faces have loaded, or `timeout` has passed, so xterm.js
 * measures its cells in that font rather than in the fallback: it measures them as it opens. A load
 * that fails, or a browser with no document.fonts, opens the terminal at once.
 */
export async function waitForFont(family: string | undefined, fonts: FontLoader | undefined = documentFonts(), timeout = FONT_WAIT_MS): Promise<void> {
  await settlesWithin(loadFont(family, fonts), timeout);
}

/**
 * The same family list, written differently: xterm.js measures its cells again only when its
 * fontFamily option changes to another string, so a font that arrived late is measured by setting
 * this. A trailing space changes nothing about which font is used.
 */
export function sameFamilyAgain(family: string): string {
  return family.endsWith(' ') ? family.trimEnd() : `${family} `;
}

/** What createXterm() needs from the session view. */
export interface XtermOptions {
  /** The id of what describes the terminal, the F6 hint, for xterm.js's textarea, which is what has focus. */
  describedBy?: string | undefined;
  /** The cells were measured again, for a font that arrived after the wait, and the terminal fitted: its new size. */
  onResize?: ((cols: number, rows: number) => void) | undefined;
  /** Where the fonts load from: document.fonts, or a test's stand-in. */
  fonts?: FontLoader | undefined;
}

/**
 * Creates the terminal in `container` once its font has loaded, or after FONT_WAIT_MS, sized to fill
 * it. A font that arrives after that makes it measure its cells again, so they fit the font, not the
 * fallback, and fit the container again (onResize says so, for the attach's size).
 */
export async function createXterm(container: HTMLElement, options: XtermOptions = {}): Promise<TerminalHandle> {
  const fontFamily = terminalFontFamily();
  const loading = loadFont(fontFamily, 'fonts' in options ? options.fonts : documentFonts());
  const inTime = await settlesWithin(loading, FONT_WAIT_MS);
  const terminal = new Terminal({
    cursorBlink: true,
    ...(fontFamily === undefined ? {} : { fontFamily }),
    fontSize: TERMINAL_FONT_SIZE,
    // Bold is the 500 face, the heaviest bundled (fonts.css), so the browser never synthesises a 700 from it.
    fontWeightBold: 500,
    scrollback: 5000,
    theme: terminalTheme(),
    // Only http: and https: links, opened with noopener and noreferrer (links.ts).
    linkHandler: terminalLinkHandler,
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(container);
  // The textarea xterm.js focuses is what a screen reader is on: the F6 hint describes it.
  if (options.describedBy !== undefined) terminal.textarea?.setAttribute('aria-describedby', options.describedBy);
  fit.fit();
  let disposed = false;
  if (!inTime && fontFamily !== undefined) {
    void loading.then((loaded) => {
      if (!loaded || disposed) return;
      terminal.options.fontFamily = sameFamilyAgain(fontFamily);
      fit.fit();
      options.onResize?.(terminal.cols, terminal.rows);
    });
  }
  return {
    get cols() {
      return terminal.cols;
    },
    get rows() {
      return terminal.rows;
    },
    write: (data) => terminal.write(data),
    onData: (listener) => {
      terminal.onData(listener);
    },
    fit: () => fit.fit(),
    focus: () => terminal.focus(),
    dispose: () => {
      disposed = true;
      terminal.dispose();
    },
  };
}
