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

/**
 * Waits until the family's regular and medium faces have loaded, or `timeout` has passed, so xterm.js
 * measures its cells in that font rather than in the fallback: it measures a cell once, as it opens,
 * so a font that arrived later would draw in cells sized for another. Bold text asks for 700, which
 * the bundled 500 face serves.
 *
 * A family list loads only the families that have an @font-face (fonts.css); the fallbacks after them
 * are ignored. A load that fails, or a browser with no document.fonts, opens the terminal at once.
 */
export async function waitForFont(
  family: string | undefined,
  fonts: FontLoader | undefined = typeof document === 'undefined' ? undefined : document.fonts,
  timeout = FONT_WAIT_MS,
): Promise<void> {
  if (family === undefined || fonts === undefined) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A load that fails, even after the timeout, settles quietly: the terminal opens with the fallback,
  // and measures its cells in that.
  const loads = Promise.resolve()
    .then(() => Promise.all([400, 500].map((weight) => fonts.load(`${weight} ${TERMINAL_FONT_SIZE}px ${family}`))))
    .then(
      () => undefined,
      () => undefined,
    );
  await Promise.race([loads, new Promise<void>((resolve) => (timer = setTimeout(resolve, timeout)))]);
  clearTimeout(timer);
}

/** Creates the terminal in `container` once its font has loaded (waitForFont), sized to fill it. */
export async function createXterm(container: HTMLElement): Promise<TerminalHandle> {
  const fontFamily = terminalFontFamily();
  await waitForFont(fontFamily);
  const terminal = new Terminal({
    cursorBlink: true,
    ...(fontFamily === undefined ? {} : { fontFamily }),
    fontSize: TERMINAL_FONT_SIZE,
    scrollback: 5000,
    theme: terminalTheme(),
    // Only http: and https: links, opened with noopener and noreferrer (links.ts).
    linkHandler: terminalLinkHandler,
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(container);
  fit.fit();
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
    dispose: () => terminal.dispose(),
  };
}
