// The #uikit route (W19): the gallery at #uikit, the app everywhere else, the token handling
// unaffected either way, and no network at all while the gallery shows.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { fakeSockets } from '../test/fixtures.js';
import { THEME_KEY } from '../theme.js';
import { TOKEN_STORAGE_KEY } from '../token.js';
import { isUikitHash } from './route.js';

// xterm.js can't draw in happy-dom. The gallery's terminal specimens get a stand-in, as in xterm.test.tsx.
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    onData() {}
    write() {}
    focus() {}
    dispose() {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));

/** A fragment navigation, as the address bar or the back button makes one. */
function go(hash: string) {
  act(() => {
    window.history.replaceState(null, '', `/${hash}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

/** Waits until every specimen's scenario has finished, so nothing is still on its way. */
async function settled() {
  // The gallery renders every specimen before its heading shows: under the whole suite's load, that's more than a second.
  await screen.findByRole('heading', { name: 'pitwall UI kit' }, { timeout: 15_000 });
  await waitFor(() => expect(document.querySelector('.uikit[data-ready]')).not.toBeNull(), { timeout: 15_000 });
}

describe('isUikitHash', () => {
  it('is #uikit, or #uikit/<section>', () => {
    expect(isUikitHash('#uikit')).toBe(true);
    expect(isUikitHash('#uikit/terminal')).toBe(true);
  });

  it("isn't anything else, the token's fragment included", () => {
    for (const hash of ['', '#', '#token=abc', '#uikitx', '#uikit=1', '#token=abc&uikit', '#UIKIT']) expect(isUikitHash(hash)).toBe(false);
  });
});

describe('the #uikit route', () => {
  it('shows the gallery at #uikit, and every specimen reaches its state', async () => {
    window.history.replaceState(null, '', '/#uikit');
    const fake = fakeSockets();
    render(<App createSocket={fake.factory} />);

    await settled();
    // The app's own page isn't there: every notice on screen is a specimen inside the gallery.
    expect([...document.querySelectorAll('main.notice')].every((notice) => notice.closest('.uikit'))).toBe(true);
    expect(document.querySelectorAll('.uikit-problem')).toHaveLength(0);
    expect(fake.sockets).toHaveLength(0);
    // Every component in every state, and no browser hover text in place of a tooltip (W25), except
    // on the conversation's entries, which W27 rebuilds.
    const titled = [...document.querySelectorAll('[title]')].filter((element) => !element.matches('.conversation > li.entry'));
    expect(titled.map((element) => element.outerHTML.slice(0, 120))).toEqual([]);
  }, 30_000);

  it('opens no WebSocket, calls no fetch and never reads the token, with the browser defaults in place', async () => {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, 'stored-token');
    window.history.replaceState(null, '', '/#uikit');
    const socket = vi.fn(() => {
      throw new Error('the gallery opened a WebSocket');
    });
    const fetch = vi.fn(() => Promise.reject(new Error('the gallery called fetch')));
    vi.stubGlobal('WebSocket', socket);
    vi.stubGlobal('fetch', fetch);
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    try {
      // No createSocket or fetch: App falls back to the browser's, which are the stubs above.
      render(<App />);
      await settled();

      expect(socket).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(getItem.mock.calls.filter(([key]) => key === TOKEN_STORAGE_KEY)).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 30_000);

  it('shows the app everywhere else', () => {
    window.history.replaceState(null, '', '/#somewhere-else');
    render(<App createSocket={fakeSockets().factory} />);

    expect(screen.getByText(/Open pitwall from the URL the/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'pitwall UI kit' })).toBeNull();
  });

  it('arriving with a token, then going to #uikit and back: the token is kept and the app reconnects with it', async () => {
    window.history.replaceState(null, '', '/#token=from-the-cli');
    const fake = fakeSockets();
    render(<App createSocket={fake.factory} />);
    expect(window.location.hash).toBe('');
    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe('from-the-cli');
    expect(fake.sockets).toHaveLength(1);

    go('#uikit');
    await settled();
    // Leaving the app closes its connection.
    expect(fake.sockets[0]!.closedByClient).toBe(true);
    expect(fake.sockets).toHaveLength(1);

    go('');
    expect(screen.queryByRole('heading', { name: 'pitwall UI kit' })).toBeNull();
    expect(fake.sockets).toHaveLength(2);
    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe('from-the-cli');
  }, 30_000);

  it('arriving at #uikit, then following a #token= link: the app takes the token as usual', async () => {
    window.history.replaceState(null, '', '/#uikit');
    const fake = fakeSockets();
    render(<App createSocket={fake.factory} />);
    await settled();
    expect(fake.sockets).toHaveLength(0);

    go('#token=from-the-cli');

    expect(screen.queryByRole('heading', { name: 'pitwall UI kit' })).toBeNull();
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain('from-the-cli');
    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe('from-the-cli');
    expect(fake.sockets).toHaveLength(1);
  }, 30_000);

  it('a link to a section stays on the gallery', async () => {
    window.history.replaceState(null, '', '/#uikit');
    render(<App createSocket={fakeSockets().factory} />);
    await settled();

    go('#uikit/terminal');

    expect(screen.getByRole('heading', { name: 'pitwall UI kit' })).toBeTruthy();
    expect(document.getElementById('uikit/terminal')).not.toBeNull();
  }, 30_000);

  it("switches the theme from the app's own switch in its bar, and the app keeps the choice", async () => {
    window.history.replaceState(null, '', '/#uikit');
    render(<App createSocket={fakeSockets().factory} />);
    await settled();
    const root = document.documentElement;
    const bar = () => within(document.querySelector<HTMLElement>('.uikit-bar') ?? document.body);

    act(() => bar().getByRole('button', { name: 'Dark theme' }).click());
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(bar().getByRole('button', { name: 'Dark theme' }).getAttribute('aria-pressed')).toBe('true');
    // Every other switch on the page, such as those in the page specimens' headers, shows the same.
    const switches = screen.getAllByRole('group', { name: 'Theme' }).filter((group) => !group.closest('[data-own-store]'));
    expect(switches.length).toBeGreaterThan(1);
    for (const group of switches) expect(within(group).getByRole('button', { name: 'Dark theme' }).getAttribute('aria-pressed')).toBe('true');
    act(() => bar().getByRole('button', { name: 'Light theme' }).click());
    expect(root.getAttribute('data-theme')).toBe('light');
    expect(window.localStorage.getItem(THEME_KEY)).toBe('light');

    // Leaving keeps it: it's the app's choice, not the gallery's.
    go('');
    expect(root.getAttribute('data-theme')).toBe('light');
  }, 30_000);
});
