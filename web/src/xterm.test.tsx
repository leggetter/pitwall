// createXterm() with xterm.js replaced: the options it gives the terminal.
import { describe, expect, it, vi } from 'vitest';

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

describe('createXterm', () => {
  it("sets pitwall's link handler, so xterm.js never uses its default confirm() and window.open", () => {
    createXterm(document.createElement('div'));
    expect(created.options).toHaveLength(1);
    expect(created.options[0]).toMatchObject({ linkHandler: terminalLinkHandler });
  });
});
