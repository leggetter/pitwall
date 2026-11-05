// The #uikit route's way in and out of the app (W19): the token kept or taken, the connection closed
// and opened again, a section link kept on the gallery. A stand-in takes the gallery's place, since
// these are about App and the route, and the real one takes 10 s or more to render each time, past
// 30 s on CI's busy runners (W149). route.test.tsx renders the real gallery.
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { fakeSockets } from '../test/fixtures.js';
import { TOKEN_STORAGE_KEY } from '../token.js';

const mounts = vi.hoisted(() => ({ count: 0 }));

vi.mock('./Gallery.js', async () => {
  const { useEffect } = await import('react');
  return {
    default: function StandInGallery() {
      useEffect(() => {
        mounts.count++;
      }, []);
      return <h1>pitwall UI kit</h1>;
    },
  };
});

/** A fragment navigation, as the address bar or the back button makes one. */
function go(hash: string) {
  act(() => {
    window.history.replaceState(null, '', `/${hash}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

/** The gallery is lazily imported, so it shows a moment after the route changes. */
const shown = () => screen.findByRole('heading', { name: 'pitwall UI kit' });

describe('the #uikit route, with a stand-in gallery', () => {
  it('arriving with a token, then going to #uikit and back: the token is kept and the app reconnects with it', async () => {
    window.history.replaceState(null, '', '/#token=from-the-cli');
    const fake = fakeSockets();
    render(<App createSocket={fake.factory} />);
    expect(window.location.hash).toBe('');
    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe('from-the-cli');
    expect(fake.sockets).toHaveLength(1);

    go('#uikit');
    await shown();
    // Leaving the app closes its connection.
    expect(fake.sockets[0]!.closedByClient).toBe(true);
    expect(fake.sockets).toHaveLength(1);

    go('');
    expect(screen.queryByRole('heading', { name: 'pitwall UI kit' })).toBeNull();
    expect(fake.sockets).toHaveLength(2);
    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe('from-the-cli');
  });

  it('arriving at #uikit, then following a #token= link: the app takes the token as usual', async () => {
    window.history.replaceState(null, '', '/#uikit');
    const fake = fakeSockets();
    render(<App createSocket={fake.factory} />);
    await shown();
    expect(fake.sockets).toHaveLength(0);

    go('#token=from-the-cli');

    expect(screen.queryByRole('heading', { name: 'pitwall UI kit' })).toBeNull();
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain('from-the-cli');
    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe('from-the-cli');
    expect(fake.sockets).toHaveLength(1);
  });

  it('a link to a section stays on the gallery, without rendering it again', async () => {
    window.history.replaceState(null, '', '/#uikit');
    const fake = fakeSockets();
    render(<App createSocket={fake.factory} />);
    await shown();
    const before = mounts.count;

    go('#uikit/terminal');

    expect(screen.getByRole('heading', { name: 'pitwall UI kit' })).toBeTruthy();
    expect(mounts.count).toBe(before);
    expect(fake.sockets).toHaveLength(0);
  });
});
