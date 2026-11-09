// The #uikit route (W19): the gallery at #uikit, the app everywhere else, and no network at all while
// the gallery shows. The real gallery takes 10 s or more to render each time, past 30 s on CI's busy
// runners, so only the tests that need it render it here, and they wait for up to 2 minutes (W149).
// routeApp.test.tsx has the token's way in and out of the app, with a stand-in gallery.
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
    options = {};
    // The parser hooks that keep the cursor steady (W45).
    parser = { registerCsiHandler: () => ({ dispose() {} }), registerEscHandler: () => ({ dispose() {} }) };
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

/**
 * A test that renders the whole gallery: about 53,000 elements, which take 6 to 7 s to render and
 * up to 6 s more to settle on a 2026 laptop, and two or three times as long on CI under the suite's load.
 */
const GALLERY_TEST_MS = 120_000;

/** Waits until every specimen's scenario has finished, so nothing is still on its way. */
async function settled() {
  // The gallery renders every specimen before its heading shows.
  await screen.findByRole('heading', { name: 'pitwall UI kit' }, { timeout: 60_000 });
  await waitFor(() => expect(document.querySelector('.uikit[data-ready]')).not.toBeNull(), { timeout: 60_000 });
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
    // Each specimen that didn't reach its state, by section and title, with what it was waiting for (W71).
    const problems = [...document.querySelectorAll('.uikit-problem')].map(
      (problem) =>
        `${problem.closest('.uikit-section')?.querySelector('h2')?.textContent} > ${problem.closest('.uikit-specimen')?.querySelector('h3')?.textContent}: ${problem.textContent}`,
    );
    expect(problems).toEqual([]);
    expect(fake.sockets).toHaveLength(0);
    // Every component in every state, and no browser hover text in place of a tooltip anywhere (W25, W27).
    const titled = [...document.querySelectorAll('[title]')];
    expect(titled.map((element) => element.outerHTML.slice(0, 120))).toEqual([]);
    // Each link in the index has its section, so #uikit/<section> finds it.
    const sections = [...document.querySelectorAll<HTMLAnchorElement>('.uikit-index a')].map((link) => link.getAttribute('href')?.slice(1) ?? '');
    expect(sections.length).toBeGreaterThan(1);
    expect(sections.filter((id) => !document.getElementById(id))).toEqual([]);
  }, GALLERY_TEST_MS);

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
  }, GALLERY_TEST_MS);

  it('shows the app everywhere else', () => {
    window.history.replaceState(null, '', '/#somewhere-else');
    render(<App createSocket={fakeSockets().factory} />);

    expect(screen.getByText('This tab has no token for pitwall.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'pitwall UI kit' })).toBeNull();
  });

  it("switches the theme from the app's own switch in its bar, and the app keeps the choice", async () => {
    window.history.replaceState(null, '', '/#uikit');
    render(<App createSocket={fakeSockets().factory} />);
    await settled();
    const root = document.documentElement;
    const bar = () => within(document.querySelector<HTMLElement>('.uikit-bar') ?? document.body);

    act(() => bar().getByRole('button', { name: 'Dark theme' }).click());
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(bar().getByRole('button', { name: 'Dark theme' }).getAttribute('aria-pressed')).toBe('true');
    // Every other switch on the page, such as those in the page specimens' headers, shows the same. Each
    // is the header's switch: the Preferences dialogs have no Theme of their own (W62).
    const switches = screen.getAllByRole('group', { name: 'Theme' }).filter((group) => !group.closest('[data-own-store]'));
    expect(switches.length).toBeGreaterThan(1);
    expect(switches.every((group) => group.classList.contains('theme-switch'))).toBe(true);
    for (const group of switches) expect(within(group).getByRole('button', { name: 'Dark theme' }).getAttribute('aria-pressed')).toBe('true');
    act(() => bar().getByRole('button', { name: 'Light theme' }).click());
    expect(root.getAttribute('data-theme')).toBe('light');
    expect(window.localStorage.getItem(THEME_KEY)).toBe('light');

    // Leaving keeps it: it's the app's choice, not the gallery's.
    go('');
    expect(root.getAttribute('data-theme')).toBe('light');
  }, GALLERY_TEST_MS);
});
