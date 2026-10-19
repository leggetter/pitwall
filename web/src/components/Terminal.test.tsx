import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ATTACH_PATH,
  PROTOCOL_VERSION,
  WS_CLOSE_TOO_MANY,
  WS_PATH,
  type ConversationPage,
  type IndexSnapshot,
  type SessionSummary,
} from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import { App } from '../App.js';
import { AttachContext, type AttachEnv } from '../attach.js';
import type { ConnectionView } from '../connection.js';
import { computeProof } from '../proof.js';
import { fakeSockets, group, NOW, session, snapshot, type FakeSocket } from '../test/fixtures.js';
import { TOKEN_STORAGE_KEY } from '../token.js';
import { Dashboard } from './Dashboard.js';
import type { TerminalHandle } from './Terminal.js';

// Made-up sessions only. xterm.js is replaced by FakeTerminal, through the
// module the view loads it from, and ResizeObserver by one the tests trigger.

/** A terminal the tests drive by hand. fit() takes the size set with `nextSize`. */
class FakeTerminal implements TerminalHandle {
  cols = 80;
  rows = 24;
  nextSize: { cols: number; rows: number } | undefined;
  written: string[] = [];
  focused = 0;
  disposed = false;
  private listeners: ((data: string) => void)[] = [];

  constructor(readonly container: HTMLElement) {
    const screenElement = document.createElement('textarea');
    screenElement.className = 'fake-terminal';
    container.append(screenElement);
  }
  write(data: Uint8Array) {
    this.written.push(new TextDecoder().decode(data));
  }
  onData(listener: (data: string) => void) {
    this.listeners.push(listener);
  }
  fit() {
    if (this.nextSize) ({ cols: this.cols, rows: this.rows } = this.nextSize);
  }
  focus() {
    this.focused += 1;
  }
  dispose() {
    this.disposed = true;
    this.container.querySelector('.fake-terminal')?.remove();
  }
  type(data: string) {
    for (const listener of this.listeners) listener(data);
  }
}

const terminals: FakeTerminal[] = [];

vi.mock('../xterm.js', () => ({
  createXterm: (container: HTMLElement) => {
    const terminal = new FakeTerminal(container);
    terminals.push(terminal);
    return terminal;
  },
}));

const observers: { callback: ResizeObserverCallback; disconnected: boolean }[] = [];

class FakeResizeObserver {
  private entry: { callback: ResizeObserverCallback; disconnected: boolean };
  constructor(callback: ResizeObserverCallback) {
    this.entry = { callback, disconnected: false };
    observers.push(this.entry);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    this.entry.disconnected = true;
  }
}

beforeEach(() => {
  terminals.length = 0;
  observers.length = 0;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const TOKEN = 'pitwall-test-token-0123456789abcdefghijklmnop';
const API_KEY = 'k'.repeat(43);
const BG = '00000000-0000-4000-8000-0000000000b1';
const nonce = (i = 0) => `${'n'.repeat(41)}${String(i).padStart(2, '0')}`;

function background(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return session({ sessionId: BG, name: 'demo-worker', kind: 'background', shortId: 'bg7f3a', state: 'working', ...overrides });
}

const snap = (sessions: SessionSummary[] = [background(), session({ name: 'demo-docs' })]): IndexSnapshot =>
  snapshot([group({ sessions })]);

/** Every conversation request gets one empty page. */
const emptyPages = vi.fn<FetchLike>(async (url) => {
  const sessionId = decodeURIComponent(url.split('/')[3] ?? '');
  const page: ConversationPage = { sessionId, entries: [{ kind: 'user', text: 'run the worker' }] };
  return new Response(JSON.stringify(page), { status: 200 });
});

function renderDashboard(first: IndexSnapshot = snap(), withAttach = true) {
  const fake = fakeSockets();
  const env: AttachEnv = { token: TOKEN, createSocket: fake.factory, host: '127.0.0.1:4517' };
  const api = createApiClient({ apiKey: API_KEY, fetch: emptyPages });
  const view: ConnectionView = { state: 'live', snapshot: first };
  const ui = (
    <ApiContext.Provider value={api}>
      {withAttach ? (
        <AttachContext.Provider value={env}>
          <Dashboard view={view} />
        </AttachContext.Provider>
      ) : (
        <Dashboard view={view} />
      )}
    </ApiContext.Provider>
  );
  const result = render(ui);
  for (const toggle of result.container.querySelectorAll<HTMLElement>('.group-toggle[aria-expanded="false"]')) fireEvent.click(toggle);
  return { ...result, fake };
}

const settle = () => act(async () => {});

async function openView(name: string): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name }));
  await settle();
  return screen.getByRole('dialog');
}

/** Clicks Attach and waits for the terminal and its socket. */
async function attach(view: HTMLElement, fake: ReturnType<typeof fakeSockets>): Promise<{ socket: FakeSocket; terminal: FakeTerminal }> {
  const before = fake.sockets.length;
  fireEvent.click(within(view).getByRole('button', { name: 'Attach' }));
  await waitFor(() => expect(fake.sockets.length).toBe(before + 1));
  return { socket: fake.last, terminal: terminals.at(-1)! };
}

/** The server's side of the handshake, up to `ready`. */
async function ready(socket: FakeSocket, n = nonce()) {
  act(() => {
    socket.open();
    socket.receive({ type: 'challenge', version: PROTOCOL_VERSION, nonce: n });
  });
  await waitFor(() => expect(socket.sent).toHaveLength(1));
  act(() => socket.receive({ type: 'ready' }));
}

const sent = (socket: FakeSocket) => socket.sent.map((data) => JSON.parse(data) as Record<string, unknown>);

function binary(socket: FakeSocket, text: string) {
  act(() => socket.onmessage?.(new MessageEvent('message', { data: new TextEncoder().encode(text).buffer })));
}

describe('SessionView: attach', () => {
  it('offers Attach for a background session, and not for an interactive one', async () => {
    renderDashboard();
    let view = await openView('demo-docs');
    expect(within(view).queryByRole('button', { name: 'Attach' })).toBeNull();
    expect(within(view).getByText(/moves it to the background/)).toBeTruthy();

    fireEvent.click(within(view).getByRole('button', { name: 'Close' }));
    view = await openView('demo-worker');
    expect(within(view).getByRole('button', { name: 'Attach' })).toBeTruthy();
  });

  it('offers no Attach where the app gave no way to attach', async () => {
    renderDashboard(snap(), false);
    const view = await openView('demo-worker');
    expect(within(view).queryByRole('button', { name: 'Attach' })).toBeNull();
  });

  it("proves the token without sending it, then opens the session at the terminal's size", async () => {
    const { fake } = renderDashboard();
    const view = await openView('demo-worker');
    const { socket, terminal } = await attach(view, fake);

    expect(socket.url).toBe(`ws://127.0.0.1:4517${ATTACH_PATH}`);
    expect(terminal.container.closest('[role="dialog"]')).toBe(view);
    await ready(socket);
    expect(sent(socket)).toEqual([
      { type: 'auth', proof: await computeProof(TOKEN, nonce()) },
      { type: 'open', sessionId: BG, cols: 80, rows: 24 },
    ]);
    act(() => socket.receive({ type: 'attached' }));
    act(() => terminal.type('hello\r'));
    for (const data of socket.sent) expect(data).not.toContain(TOKEN);
    expect(within(view).getByRole('status').textContent).toBe('Attached');
  });

  it('shows output in the terminal, sends typing, and focuses the terminal once attached', async () => {
    const { fake } = renderDashboard();
    const view = await openView('demo-worker');
    const { socket, terminal } = await attach(view, fake);
    await ready(socket);
    act(() => socket.receive({ type: 'attached' }));
    expect(terminal.focused).toBe(1);

    binary(socket, '\u001b[1mready\u001b[0m');
    expect(terminal.written).toEqual(['\u001b[1mready\u001b[0m']);
    act(() => terminal.type('what is 2+2?\r'));
    expect(sent(socket).at(-1)).toEqual({ type: 'input', data: 'what is 2+2?\r' });
  });

  it('takes the place of the conversation, which comes back on Detach, and detaching closes the socket', async () => {
    const { fake } = renderDashboard();
    const view = await openView('demo-worker');
    const body = view.querySelector<HTMLElement>('.session-view-body')!;
    expect(body.hidden).toBe(false);
    const { socket, terminal } = await attach(view, fake);
    expect(body.hidden).toBe(true);
    expect(within(view).queryByRole('button', { name: 'Attach' })).toBeNull();

    fireEvent.click(within(view).getByRole('button', { name: 'Detach' }));
    expect(socket.closedByClient).toBe(true);
    expect(terminal.disposed).toBe(true);
    expect(body.hidden).toBe(false);
    expect(document.activeElement).toBe(within(view).getByRole('button', { name: 'Attach' }));
  });

  it('sends a resize when the panel resizes', async () => {
    const { fake } = renderDashboard();
    const view = await openView('demo-worker');
    const { socket, terminal } = await attach(view, fake);
    await ready(socket);
    act(() => socket.receive({ type: 'attached' }));

    terminal.nextSize = { cols: 132, rows: 41 };
    act(() => observers.at(-1)!.callback([], {} as ResizeObserver));
    expect(sent(socket).at(-1)).toEqual({ type: 'resize', cols: 132, rows: 41 });

    // The same size again sends nothing.
    act(() => observers.at(-1)!.callback([], {} as ResizeObserver));
    expect(sent(socket).filter((message) => message.type === 'resize')).toHaveLength(1);
  });

  describe('a session that is not running', () => {
    async function needingRestart() {
      const { fake } = renderDashboard(snap([background({ pid: undefined, alive: false, status: undefined, state: 'done' })]));
      // A finished session sits in its group's collapsed Finished list, and keeps attach.
      fireEvent.click(screen.getByRole('button', { name: 'Finished (1)', expanded: false }));
      const view = await openView('demo-worker');
      const { socket, terminal } = await attach(view, fake);
      await ready(socket);
      act(() => socket.receive({ type: 'needs-restart' }));
      return { view, socket, terminal };
    }

    it('asks before restarting it, and sends restart only after the user confirms', async () => {
      const { view, socket } = await needingRestart();
      const confirm = within(view).getByRole('alertdialog');
      expect(confirm.textContent).toContain("This session isn't running. Attaching restarts it.");
      expect(sent(socket).map((message) => message.type)).toEqual(['auth', 'open']);
      expect(sent(socket).some((message) => message.restart !== undefined)).toBe(false);

      fireEvent.click(within(confirm).getByRole('button', { name: 'Restart and attach' }));
      expect(sent(socket).at(-1)).toEqual({ type: 'open', sessionId: BG, cols: 80, rows: 24, restart: true });
      expect(within(view).queryByRole('alertdialog')).toBeNull();
      act(() => socket.receive({ type: 'attached' }));
      expect(within(view).getByRole('status').textContent).toBe('Attached');
    });

    it('cancelling closes the socket without restarting, and goes back to the conversation', async () => {
      const { view, socket, terminal } = await needingRestart();
      fireEvent.click(within(within(view).getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
      expect(socket.closedByClient).toBe(true);
      expect(terminal.disposed).toBe(true);
      expect(sent(socket).some((message) => message.restart === true)).toBe(false);
      expect(view.querySelector<HTMLElement>('.session-view-body')!.hidden).toBe(false);
    });
  });

  it('says so when 4 sessions are already attached, and can try again', async () => {
    const { fake } = renderDashboard();
    const view = await openView('demo-worker');
    const { socket } = await attach(view, fake);
    act(() => {
      socket.open();
      socket.receive({ type: 'challenge', version: PROTOCOL_VERSION, nonce: nonce() });
    });
    await waitFor(() => expect(socket.sent).toHaveLength(1));
    act(() => socket.serverClose(WS_CLOSE_TOO_MANY));

    expect(within(view).getByRole('alert').textContent).toBe('4 sessions are already attached; detach one first.');
    fireEvent.click(within(view).getByRole('button', { name: 'Attach again' }));
    await waitFor(() => expect(fake.sockets).toHaveLength(2));
    expect(within(view).queryByRole('alert')).toBeNull();
  });

  it('shows a short notice when claude attach exits, or the server refuses', async () => {
    const { fake } = renderDashboard();
    const view = await openView('demo-worker');
    const first = await attach(view, fake);
    await ready(first.socket);
    act(() => first.socket.receive({ type: 'attached' }));
    act(() => first.socket.receive({ type: 'exit', code: 0 }));
    expect(within(view).getByRole('alert').textContent).toBe('claude attach ended.');
    expect(within(view).getByRole('button', { name: 'Back to the conversation' })).toBeTruthy();

    fireEvent.click(within(view).getByRole('button', { name: 'Attach again' }));
    await waitFor(() => expect(fake.sockets).toHaveLength(2));
    await ready(fake.last);
    act(() => fake.last.receive({ type: 'error', error: 'Only background sessions can be attached.' }));
    expect(within(view).getByRole('alert').textContent).toBe("Couldn't attach: Only background sessions can be attached.");
  });

  it('detaches when the panel closes', async () => {
    const { fake } = renderDashboard();
    const view = await openView('demo-worker');
    const { socket, terminal } = await attach(view, fake);
    await ready(socket);
    act(() => socket.receive({ type: 'attached' }));

    fireEvent.click(within(view).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(socket.closedByClient).toBe(true);
    expect(terminal.disposed).toBe(true);
    expect(observers.at(-1)!.disconnected).toBe(true);
  });

  it('keeps Escape for the terminal, and closes the panel on Escape elsewhere', async () => {
    const { fake } = renderDashboard();
    const view = await openView('demo-worker');
    const { socket, terminal } = await attach(view, fake);
    await ready(socket);
    act(() => socket.receive({ type: 'attached' }));

    fireEvent.keyDown(terminal.container.querySelector('.fake-terminal')!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBe(view);
    expect(socket.closedByClient).toBe(false);

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(socket.closedByClient).toBe(true);
  });
});

describe('App: attach', () => {
  it('attaches with the token it holds, sending only proofs on every socket', async () => {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, TOKEN);
    const fake = fakeSockets();
    render(<App createSocket={fake.factory} fetch={emptyPages} />);
    const index = fake.last;
    expect(index.url).toContain(WS_PATH);
    act(() => {
      index.open();
      index.receive({ type: 'challenge', version: PROTOCOL_VERSION, nonce: nonce(1) });
    });
    await waitFor(() => expect(index.sent).toHaveLength(1));
    act(() => index.receive({ type: 'authenticated', apiKey: API_KEY }));
    act(() => index.receive({ type: 'snapshot', snapshot: snap() }));
    fireEvent.click(screen.getByRole('button', { expanded: false, name: /demo-app/ }));

    const view = await openView('demo-worker');
    const { socket } = await attach(view, fake);
    expect(socket.url).toBe(`ws://${window.location.host}${ATTACH_PATH}`);
    await ready(socket, nonce(2));
    expect(sent(socket)[0]).toEqual({ type: 'auth', proof: await computeProof(TOKEN, nonce(2)) });
    for (const each of fake.sockets) for (const data of each.sent) expect(data).not.toContain(TOKEN);
    for (const [url, init] of emptyPages.mock.calls) expect(`${url} ${JSON.stringify(init)}`).not.toContain(TOKEN);
  });
});
