// The real terminal: xterm.js with the fit addon. Loaded with import() on the
// first attach, so the dashboard doesn't download it until it's needed.

import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { TerminalHandle } from './components/Terminal.js';

export function createXterm(container: HTMLElement): TerminalHandle {
  const terminal = new Terminal({
    cursorBlink: true,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
    fontSize: 13,
    scrollback: 5000,
    theme: { background: '#0e1115', foreground: '#e6e9ee', cursor: '#e6e9ee' },
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
