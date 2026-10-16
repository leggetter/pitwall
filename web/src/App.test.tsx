import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WS_CLOSE_UNAUTHORIZED } from '../../src/shared/protocol.js';
import { App } from './App.js';
import { fakeSockets, mixedSnapshot } from './test/fixtures.js';
import { TOKEN_STORAGE_KEY } from './token.js';

describe('App', () => {
  it('without a token, says where to open pitwall from and opens no socket', () => {
    const fake = fakeSockets();
    render(<App createSocket={fake.factory} />);

    expect(screen.getByText(/Open pitwall from the URL the/)).toHaveProperty(
      'textContent',
      'Open pitwall from the URL the pitwall command printed.',
    );
    expect(fake.sockets).toHaveLength(0);
  });

  it('takes the token from the URL, cleans the address bar and authenticates with it first', () => {
    window.history.replaceState(null, '', '/#token=from-the-cli');
    const fake = fakeSockets();
    render(<App createSocket={fake.factory} />);

    expect(window.location.href).not.toContain('from-the-cli');
    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe('from-the-cli');
    expect(fake.last.url).toBe(`ws://${window.location.host}/ws`);

    act(() => fake.last.open());
    expect(fake.last.sent.map((data) => JSON.parse(data))).toEqual([{ type: 'auth', token: 'from-the-cli' }]);
  });

  it('uses the stored token after a reload', () => {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, 'stored');
    const fake = fakeSockets();
    render(<App createSocket={fake.factory} />);

    act(() => fake.last.open());
    expect(JSON.parse(fake.last.sent[0]!)).toEqual({ type: 'auth', token: 'stored' });
  });

  it('shows the connection state and then the sessions from the snapshot', () => {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, 'stored');
    const fake = fakeSockets();
    render(<App createSocket={fake.factory} />);

    expect(screen.getByText('Connecting')).toBeTruthy();
    expect(screen.getByText('Connecting to pitwall…')).toBeTruthy();

    act(() => {
      fake.last.open();
      fake.last.receive({ type: 'snapshot', snapshot: mixedSnapshot() });
    });

    expect(screen.getByText('Live')).toBeTruthy();
    expect(screen.getByText('demo-docs')).toBeTruthy();
  });

  it('on 4401, says the token was rejected and stops reconnecting', () => {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, 'wrong');
    const fake = fakeSockets();
    render(<App createSocket={fake.factory} />);

    act(() => {
      fake.last.open();
      fake.last.serverClose(WS_CLOSE_UNAUTHORIZED);
    });

    expect(screen.getByText('Token rejected; reopen pitwall from the URL the command printed.')).toBeTruthy();
    expect(fake.sockets).toHaveLength(1);
  });

  it('picks up a new token when the fragment changes, and reconnects with it', () => {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, 'old');
    const fake = fakeSockets();
    render(<App createSocket={fake.factory} />);
    act(() => fake.last.serverClose(WS_CLOSE_UNAUTHORIZED));
    expect(screen.getByText(/Token rejected/)).toBeTruthy();

    act(() => {
      window.history.replaceState(null, '', '/#token=new');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });

    expect(window.location.hash).toBe('');
    expect(fake.sockets).toHaveLength(2);
    act(() => fake.last.open());
    expect(JSON.parse(fake.last.sent[0]!)).toEqual({ type: 'auth', token: 'new' });
    expect(screen.queryByText(/Token rejected/)).toBeNull();
  });

  it('closes the socket when it unmounts', () => {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, 'stored');
    const fake = fakeSockets();
    const { unmount } = render(<App createSocket={fake.factory} />);

    unmount();

    expect(fake.last.closedByClient).toBe(true);
  });
});
