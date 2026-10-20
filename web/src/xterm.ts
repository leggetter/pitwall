// The real terminal: xterm.js with the fit addon. Loaded with import() on the
// first attach, so the dashboard doesn't download it until it's needed.

import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { TerminalHandle } from './components/Terminal.js';
import { terminalLinkHandler } from './links.js';

/** xterm.js theme keys, and the custom properties in tokens.css they come from. */
const THEME_TOKENS = [
  ['background', '--pw-term-bg'],
  ['foreground', '--pw-term-fg'],
  ['cursor', '--pw-term-cursor'],
] as const satisfies readonly (readonly [keyof ITheme, string])[];

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

export function createXterm(container: HTMLElement): TerminalHandle {
  const terminal = new Terminal({
    cursorBlink: true,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
    fontSize: 13,
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
