import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { conversationPath, PROTOCOL_VERSION, WS_CLOSE_UNAUTHORIZED, type SessionSummary } from '../../src/shared/protocol.js';
import type { FetchLike } from './api.js';
import { App } from './App.js';
import { computeProof } from './connection.js';
import { fakeSockets, group, minutesAgo, mixedSnapshot, session, snapshot, type FakeSocket } from './test/fixtures.js';
import { TOKEN_STORAGE_KEY } from './token.js';

const SESSION_ID = '00000000-0000-4000-8000-0000000000b1';
const SESSION_NAME = 'pitwall-test-conversation';
const KEY_A = 'a'.repeat(43);
const KEY_B = 'b'.repeat(43);
const KEY_C = 'c'.repeat(43);
const nonce = (i = 0) => `${'n'.repeat(41)}${String(i).padStart(2, '0')}`;

const authorization = (init: RequestInit) => (init.headers as Record<string, string>).Authorization;

/** Challenges the socket, waits for the page's proof, then accepts it with `apiKey`. */
async function handshake(socket: FakeSocket, apiKey = KEY_A, n = nonce()) {
  act(() => {
    socket.open();
    socket.receive({ type: 'challenge', version: PROTOCOL_VERSION, nonce: n });
  });
  await waitFor(() => expect(socket.sent).toHaveLength(1));
  act(() => socket.receive({ type: 'authenticated', apiKey }));
}

function conversationSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return session({ sessionId: SESSION_ID, name: SESSION_NAME, lastActivityAt: minutesAgo(5), ...overrides });
}

/** A page of the conversation with one reply in it. */
const pageBody = (text = 'The newest reply.') =>
  new Response(JSON.stringify({ sessionId: SESSION_ID, entries: [{ kind: 'assistant', at: minutesAgo(5), text }] }), { status: 200 });

/** Pushes a snapshot in which the session's last activity is `minutes` ago, so an open view fetches its conversation again when it changes. */
function showSession(socket: FakeSocket, minutes = 5) {
  act(() => socket.receive({ type: 'snapshot', snapshot: snapshot([group({ sessions: [conversationSession({ lastActivityAt: minutesAgo(minutes) })] })]) }));
}

/**
 * Renders the app with one session listed, and returns the button on its row that opens it. With
 * `authenticate: false` the server then restarts, so the page has a snapshot but no apiKey until its
 * next handshake.
 */
async function appWithSession(fetch: FetchLike, { authenticate = true } = {}) {
  const fake = fakeSockets();
  render(<App createSocket={fake.factory} fetch={fetch} />);
  await handshake(fake.last);
  showSession(fake.last);
  if (!authenticate) act(() => fake.last.serverClose(1001));
  return { fake, open: screen.getByRole('button', { name: SESSION_NAME }) };
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

  it('takes the token from the URL, cleans the address bar, and answers the challenge with a proof, not the token', async () => {
    window.history.replaceState(null, '', '/#token=from-the-cli');
    const fake = fakeSockets();
    render(<App createSocket={fake.factory} />);

    expect(window.location.href).not.toContain('from-the-cli');
    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe('from-the-cli');
    expect(fake.last.url).toBe(`ws://${window.location.host}/ws`);

    act(() => fake.last.open());
    expect(fake.last.sent).toEqual([]);
    await handshake(fake.last);
    expect(fake.last.sent.map((data) => JSON.parse(data))).toEqual([{ type: 'auth', proof: await computeProof('from-the-cli', nonce()) }]);
  });

  it('uses the stored token after a reload', async () => {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, 'stored');
    const fake = fakeSockets();
    render(<App createSocket={fake.factory} />);

    await handshake(fake.last);
    expect(JSON.parse(fake.last.sent[0]!)).toEqual({ type: 'auth', proof: await computeProof('stored', nonce()) });
  });

  it('shows the connection state and then the sessions from the snapshot', async () => {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, 'stored');
    const fake = fakeSockets();
    render(<App createSocket={fake.factory} />);

    expect(screen.getByText('Connecting…')).toBeTruthy();
    // The skeletons and their status, after --pw-delay-spinner.
    await waitFor(() => expect(screen.getByText('Loading sessions')).toBeTruthy());

    await handshake(fake.last);
    act(() => fake.last.receive({ type: 'snapshot', snapshot: mixedSnapshot() }));

    expect(screen.getByText('Live')).toBeTruthy();
    expect(screen.getByText('demo-docs')).toBeTruthy();
  });

  it('keeps the sessions on a heartbeat, and shows its source warning', async () => {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, 'stored');
    const fake = fakeSockets();
    const { container } = render(<App createSocket={fake.factory} />);
    await handshake(fake.last);
    act(() => fake.last.receive({ type: 'snapshot', snapshot: mixedSnapshot() }));
    const heading = container.querySelector('.group-label');

    act(() =>
      fake.last.receive({ type: 'heartbeat', generatedAt: new Date().toISOString(), source: { ok: false, error: 'timed out' } }),
    );

    expect(screen.getByText('Live')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('failed on the latest poll: timed out');
    expect(container.querySelector('.group-label')).toBe(heading);
    expect(screen.getByText('updated 0s ago')).toBeTruthy();
  });

  it("fetches an opened session's conversation with the apiKey as a bearer token, never the token", async () => {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, 'stored');
    const fetch = vi.fn<FetchLike>(async () => pageBody());
    const { open } = await appWithSession(fetch);

    await act(async () => fireEvent.click(open));

    expect(fetch).toHaveBeenCalledWith(
      conversationPath(SESSION_ID),
      expect.objectContaining({ headers: { Authorization: `Bearer ${KEY_A}` }, cache: 'no-store' }),
    );
    expect(screen.getByText('The newest reply.')).toBeTruthy();
  });

  it('opening a session waits while there is no apiKey, then fetches with the next one', async () => {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, 'stored');
    const fetch = vi.fn<FetchLike>(async () => pageBody());
    const { fake, open } = await appWithSession(fetch, { authenticate: false });

    await act(async () => fireEvent.click(open));
    // After --pw-delay-spinner.
    await waitFor(() => expect(screen.getByText('Loading the conversation…')).toBeTruthy());
    expect(fetch).not.toHaveBeenCalled();

    // The page reconnects after its backoff, and the new server accepts its proof.
    await waitFor(() => expect(fake.sockets).toHaveLength(2), { timeout: 3_000 });
    await handshake(fake.last, KEY_B, nonce(2));
    await waitFor(() => expect(screen.getByText('The newest reply.')).toBeTruthy());
    expect(fetch.mock.calls.map(([, init]) => authorization(init))).toEqual([`Bearer ${KEY_B}`]);
  });

  it('after a server restart, picks up the new apiKey from a fresh handshake', async () => {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, 'stored');
    const fetch = vi.fn<FetchLike>(async () => pageBody());
    const { fake, open } = await appWithSession(fetch);
    await act(async () => fireEvent.click(open));

    act(() => fake.last.serverClose(1001));
    await waitFor(() => expect(fake.sockets).toHaveLength(2), { timeout: 3_000 });
    await handshake(fake.last, KEY_B, nonce(2));
    showSession(fake.last, 1);

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(fetch.mock.calls.map(([, init]) => authorization(init))).toEqual([`Bearer ${KEY_A}`, `Bearer ${KEY_B}`]);
    // Each connection answered its own challenge.
    expect(JSON.parse(fake.sockets[1]!.sent[0]!)).toEqual({ type: 'auth', proof: await computeProof('stored', nonce(2)) });
  });

  it('takes an HTTP 401 as a stale apiKey: it reconnects and retries, and never says the token was rejected', async () => {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, 'stored');
    const fetch = vi.fn<FetchLike>(async (_url, init) =>
      authorization(init) === `Bearer ${KEY_A}` ? new Response(null, { status: 401 }) : pageBody('Fetched with the fresh key.'),
    );
    const { fake, open } = await appWithSession(fetch);

    await act(async () => fireEvent.click(open));
    // Straight away, not after a backoff: the old socket is replaced for a fresh challenge.
    await waitFor(() => expect(fake.sockets).toHaveLength(2));
    expect(fake.sockets[0]!.closedByClient).toBe(true);
    expect(screen.queryByText(/Token rejected/)).toBeNull();

    await handshake(fake.last, KEY_B, nonce(2));
    await waitFor(() => expect(screen.getByText('Fetched with the fresh key.')).toBeTruthy());
    expect(fetch.mock.calls.map(([, init]) => authorization(init))).toEqual([`Bearer ${KEY_A}`, `Bearer ${KEY_B}`]);
    expect(screen.queryByText(/Token rejected/)).toBeNull();
  });

  it('never sends the raw token: not in a frame, a URL or a request header, across a restart and a stale key', async () => {
    const TOKEN = 'pitwall-test-token-NEVER-SENT-0123456789abcdef';
    window.history.replaceState(null, '', `/#token=${TOKEN}`);
    const fetch = vi.fn<FetchLike>(async (_url, init) =>
      authorization(init) === `Bearer ${KEY_B}` ? new Response(null, { status: 401 }) : pageBody(),
    );
    const fake = fakeSockets();
    render(<App createSocket={fake.factory} fetch={fetch} />);

    // First connection, and an opened session's conversation.
    await handshake(fake.last, KEY_A, nonce(1));
    showSession(fake.last, 5);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: SESSION_NAME })));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    // The server restarts; the page reconnects and gets a new key.
    act(() => fake.last.serverClose(1001));
    await waitFor(() => expect(fake.sockets).toHaveLength(2), { timeout: 3_000 });
    await handshake(fake.last, KEY_B, nonce(2));

    // That key turns out stale: a 401, an immediate reconnect, and a retry with the next key.
    showSession(fake.last, 4);
    await waitFor(() => expect(fake.sockets).toHaveLength(3));
    await handshake(fake.last, KEY_C, nonce(3));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));

    expect(fetch.mock.calls.map(([, init]) => authorization(init))).toEqual([`Bearer ${KEY_A}`, `Bearer ${KEY_B}`, `Bearer ${KEY_C}`]);
    const frames = fake.sockets.flatMap((socket) => socket.sent);
    expect(frames).toHaveLength(3);
    for (const frame of frames) {
      expect(frame).not.toContain(TOKEN);
      expect(Object.keys(JSON.parse(frame) as object)).toEqual(['type', 'proof']);
    }
    for (const socket of fake.sockets) expect(socket.url).not.toContain(TOKEN);
    for (const [url, init] of fetch.mock.calls) {
      expect(url).not.toContain(TOKEN);
      expect(JSON.stringify(init)).not.toContain(TOKEN);
      expect(Object.values(init.headers as Record<string, string>).join('\n')).not.toContain(TOKEN);
    }
    expect(screen.queryByText(/Token rejected/)).toBeNull();
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

  it('picks up a new token when the fragment changes, and reconnects with it', async () => {
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
    await handshake(fake.last);
    expect(JSON.parse(fake.last.sent[0]!)).toEqual({ type: 'auth', proof: await computeProof('new', nonce()) });
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
