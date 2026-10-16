import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { lastMessagePath, WS_CLOSE_UNAUTHORIZED } from '../../src/shared/protocol.js';
import { App } from './App.js';
import type { FetchLike } from './lastMessage.js';
import { fakeSockets, group, mixedSnapshot, session, snapshot } from './test/fixtures.js';
import { TOKEN_STORAGE_KEY } from './token.js';

const LONG_REPLY_ID = '00000000-0000-4000-8000-0000000000b1';

/** Renders the app with one long reply on screen, its group open, and returns the "Show more" button. */
function appWithLongReply(fetch: FetchLike) {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(120);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(40);
  const fake = fakeSockets();
  const target = session({ sessionId: LONG_REPLY_ID, name: 'long-reply', lastAssistantText: 'A long reply…' });
  render(<App createSocket={fake.factory} fetch={fetch} />);
  act(() => {
    fake.last.open();
    fake.last.receive({ type: 'snapshot', snapshot: snapshot([group({ sessions: [target] })]) });
  });
  fireEvent.click(screen.getByRole('button', { expanded: false, name: /demo-app/ }));
  return { fake, more: screen.getByRole('button', { name: 'Show more' }) };
}

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

  it('keeps the sessions on a heartbeat, and shows its source warning', () => {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, 'stored');
    const fake = fakeSockets();
    const { container } = render(<App createSocket={fake.factory} />);
    act(() => {
      fake.last.open();
      fake.last.receive({ type: 'snapshot', snapshot: mixedSnapshot() });
    });
    const heading = container.querySelector('.group-label');

    act(() =>
      fake.last.receive({ type: 'heartbeat', generatedAt: new Date().toISOString(), source: { ok: false, error: 'timed out' } }),
    );

    expect(screen.getByText('Live')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('failed on the latest poll: timed out');
    expect(container.querySelector('.group-label')).toBe(heading);
    expect(screen.getByText('updated 0s ago')).toBeTruthy();
  });

  it('fetches the full reply with the stored token as a bearer token', async () => {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, 'stored');
    const body = { sessionId: LONG_REPLY_ID, text: 'The whole reply.', truncated: false };
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(body), { status: 200 }));
    const { more } = appWithLongReply(fetch);

    await act(async () => fireEvent.click(more));

    expect(fetch).toHaveBeenCalledWith(lastMessagePath(LONG_REPLY_ID), {
      headers: { Authorization: 'Bearer stored' },
      cache: 'no-store',
    });
    expect(screen.getByText('The whole reply.')).toBeTruthy();
  });

  it('treats a 401 from the reply API like a rejected token, and closes the socket', async () => {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, 'stale');
    const fetch = vi.fn<FetchLike>(async () => new Response(null, { status: 401 }));
    const { fake, more } = appWithLongReply(fetch);

    await act(async () => fireEvent.click(more));

    expect(screen.getByText('Token rejected; reopen pitwall from the URL the command printed.')).toBeTruthy();
    expect(fake.last.closedByClient).toBe(true);
    expect(fake.sockets).toHaveLength(1);
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
