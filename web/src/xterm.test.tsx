// createXterm() with xterm.js replaced: the options it gives the terminal.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import tokensCss from './tokens.css?raw';

const created = vi.hoisted(() => ({ options: [] as unknown[] }));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    constructor(options: unknown) {
      created.options.push(options);
    }
    loadAddon() {}
    open() {}
    onData() {}
    write() {}
    focus() {}
    dispose() {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));

const { createXterm } = await import('./xterm.js');
const { terminalLinkHandler } = await import('./links.js');

/** The theme createXterm() gave the terminal it just created. */
function lastTheme(): unknown {
  return (created.options.at(-1) as { theme?: unknown } | undefined)?.theme;
}

describe('createXterm', () => {
  beforeEach(() => {
    created.options.length = 0;
  });

  afterEach(() => {
    for (const style of document.head.querySelectorAll('style')) style.remove();
    document.documentElement.removeAttribute('style');
  });

  it("sets pitwall's link handler, so xterm.js never uses its default confirm() and window.open", () => {
    createXterm(document.createElement('div'));
    expect(created.options).toHaveLength(1);
    expect(created.options[0]).toMatchObject({ linkHandler: terminalLinkHandler });
  });

  it('takes its colours from the --pw-term-* tokens in tokens.css', () => {
    const style = document.createElement('style');
    style.textContent = tokensCss;
    document.head.append(style);
    createXterm(document.createElement('div'));
    expect(lastTheme()).toEqual({ background: '#141412', foreground: '#F5F5F5', cursor: '#F5F5F5' });
  });

  it('reads the tokens when the terminal is created, not before', () => {
    const root = document.documentElement;
    root.style.setProperty('--pw-term-bg', '#010203');
    root.style.setProperty('--pw-term-fg', '#040506');
    root.style.setProperty('--pw-term-cursor', '#070809');
    createXterm(document.createElement('div'));
    expect(lastTheme()).toEqual({ background: '#010203', foreground: '#040506', cursor: '#070809' });

    root.style.setProperty('--pw-term-bg', '#0a0b0c');
    createXterm(document.createElement('div'));
    expect(lastTheme()).toMatchObject({ background: '#0a0b0c' });
  });

  it("leaves out a token that isn't set, so xterm.js uses its default for it", () => {
    document.documentElement.style.setProperty('--pw-term-bg', '#010203');
    createXterm(document.createElement('div'));
    expect(lastTheme()).toEqual({ background: '#010203' });
  });
});
