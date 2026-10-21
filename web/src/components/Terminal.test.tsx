import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import { descriptionOf } from '../test/tooltips.js';
import { TOKEN_STORAGE_KEY } from '../token.js';
import { Dashboard } from './Dashboard.js';
import { NEW_LINE, type TerminalHandle } from './Terminal.js';

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
  /** Every key that reached the screen, as xterm.js's own listener on its textarea would get it. */
  keys: string[] = [];
  readonly screen: HTMLTextAreaElement;
  private listeners: ((data: string) => void)[] = [];

  constructor(readonly container: HTMLElement) {
    this.screen = document.createElement('textarea');
    this.screen.className = 'fake-terminal';
    this.screen.addEventListener(
      'keydown',
      (event) => {
        const held = `${event.ctrlKey ? 'Ctrl+' : ''}${event.altKey ? 'Alt+' : ''}${event.metaKey ? 'Meta+' : ''}${event.shiftKey ? 'Shift+' : ''}`;
        this.keys.push(`${held}${event.key}`);
        // Enter, as xterm.js sends it whatever else is held (Keyboard.ts): a carriage return, after
        // ESC with Alt. keyCode 229 is its composition helper's, which sends nothing for it.
        if (event.key === 'Enter' && event.keyCode !== 229) this.type(event.altKey ? '\u001b\r' : '\r');
      },
      true,
    );
    container.append(this.screen);
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
    this.screen.focus();
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
/** The options each terminal was created with, as the session view gave them. */
const created: { describedBy?: string | undefined; onResize?: ((cols: number, rows: number) => void) | undefined }[] = [];

vi.mock('../xterm.js', () => ({
  createXterm: (container: HTMLElement, options: (typeof created)[number] = {}) => {
    const terminal = new FakeTerminal(container);
    terminals.push(terminal);
    created.push(options);
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
  created.length = 0;
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
  return { ...result, fake };
}

const settle = () => act(async () => {});

async function openView(name: string): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name }));
  await settle();
  return screen.getByRole('dialog');
}

const tab = (view: HTMLElement, name: 'Conversation' | 'Terminal') => within(view).getByRole('tab', { name: new RegExp(`^${name}`) });

/** Opens the Terminal tab and waits for the terminal and its socket. */
async function attach(view: HTMLElement, fake: ReturnType<typeof fakeSockets>): Promise<{ socket: FakeSocket; terminal: FakeTerminal }> {
  const before = fake.sockets.length;
  fireEvent.click(tab(view, 'Terminal'));
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

/** The notice above the screen, an inline alert. */
const notice = (view: HTMLElement) => view.querySelector<HTMLElement>('.attach-notice');

/** The bar's status badge. */
const statusBadge = (view: HTMLElement) => view.querySelector<HTMLElement>('.attach-bar [role="status"] .badge')!;

function binary(socket: FakeSocket, text: string) {
  act(() => socket.onmessage?.(new MessageEvent('message', { data: new TextEncoder().encode(text).buffer })));
}

describe('SessionView: attach, from the Terminal tab', () => {
  it("opens for a background session; an interactive session's Terminal tab is aria-disabled, says why, and attaches nothing", async () => {
    const { fake } = renderDashboard();
    let view = await openView('demo-docs');
    const off = tab(view, 'Terminal');
    expect(off.getAttribute('aria-disabled')).toBe('true');
    // Why, in a tooltip that describes it, and in the DOM before it shows; no title.
    expect(descriptionOf(off)).toMatch(/Typing \/bg in its terminal moves it to the background/);
    expect(off.hasAttribute('title')).toBe(false);
    fireEvent.click(off);
    await settle();
    expect(off.getAttribute('aria-selected')).toBe('false');
    expect(fake.sockets).toHaveLength(0);

    fireEvent.click(within(view).getByRole('button', { name: 'Close' }));
    view = await openView('demo-worker');
    expect(tab(view, 'Terminal').hasAttribute('aria-disabled')).toBe(false);
    await attach(view, fake);
    expect(tab(view, 'Terminal').getAttribute('aria-selected')).toBe('true');
  });

  it("is aria-disabled where the app gave no way to attach", async () => {
    renderDashboard(snap(), false);
    const view = await openView('demo-worker');
    expect(tab(view, 'Terminal').getAttribute('aria-disabled')).toBe('true');
    expect(descriptionOf(tab(view, 'Terminal'))).toBe('Attach is unavailable here.');
  });

  it('attaches only when Terminal is opened, never when the view opens', async () => {
    const { fake } = renderDashboard();
    const view = await openView('demo-worker');
    expect(tab(view, 'Conversation').getAttribute('aria-selected')).toBe('true');
    expect(fake.sockets).toHaveLength(0);
    // Focus alone never opens a tab: activation is manual.
    tab(view, 'Conversation').focus();
    fireEvent.keyDown(tab(view, 'Conversation'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tab(view, 'Terminal'));
    await settle();
    expect(fake.sockets).toHaveLength(0);
  });

  it('detaches when the Conversation tab is opened, and attaches afresh on Terminal', async () => {
    const { fake } = renderDashboard();
    const view = await openView('demo-worker');
    const first = await attach(view, fake);
    await ready(first.socket);
    act(() => first.socket.receive({ type: 'attached' }));

    fireEvent.click(tab(view, 'Conversation'));
    expect(first.socket.closedByClient).toBe(true);
    expect(first.terminal.disposed).toBe(true);
    expect(tab(view, 'Conversation').getAttribute('aria-selected')).toBe('true');
    expect(view.querySelector<HTMLElement>('.session-view-body')!.hidden).toBe(false);

    const second = await attach(view, fake);
    expect(second.socket).not.toBe(first.socket);
    expect(fake.sockets).toHaveLength(2);
  });

  it('shows a success dot on the Terminal tab while attached, and says so to screen readers', async () => {
    const { fake } = renderDashboard();
    const view = await openView('demo-worker');
    const { socket } = await attach(view, fake);
    expect(view.querySelector('.session-tab-dot')).toBeNull();
    await ready(socket);
    act(() => socket.receive({ type: 'attached' }));
    expect(view.querySelector('.session-tab .session-tab-dot')).not.toBeNull();
    // happy-dom gives spans no display, so the accessible name gets a space before the comma, where a browser has none.
    expect(within(view).getByRole('tab', { name: /^Terminal ?, attached$/ })).toBe(tab(view, 'Terminal'));

    act(() => socket.receive({ type: 'exit', code: 0 }));
    expect(view.querySelector('.session-tab-dot')).toBeNull();
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
    const panel = document.getElementById(tab(view, 'Terminal').getAttribute('aria-controls')!)!;
    expect(panel.getAttribute('role')).toBe('tabpanel');
    expect(panel.contains(terminal.container)).toBe(true);

    fireEvent.click(within(view).getByRole('button', { name: 'Detach' }));
    expect(socket.closedByClient).toBe(true);
    expect(terminal.disposed).toBe(true);
    expect(body.hidden).toBe(false);
    expect(tab(view, 'Conversation').getAttribute('aria-selected')).toBe('true');
    // Back on the tab that attaches again.
    expect(document.activeElement).toBe(tab(view, 'Terminal'));
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
      const { fake } = renderDashboard(snap([background({ pid: undefined, alive: false, status: undefined, state: 'done', finished: true })]));
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
      const confirm = within(view).getByRole('alertdialog', {
        name: 'Restart and attach?',
        description: 'This session has finished, or its process has exited. Attaching restarts it.',
      });
      // Cancel takes focus as it opens (W22 found it didn't).
      expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: 'Cancel' }));
      expect(sent(socket).map((message) => message.type)).toEqual(['auth', 'open']);
      expect(sent(socket).some((message) => message.restart !== undefined)).toBe(false);

      fireEvent.click(within(confirm).getByRole('button', { name: 'Restart and attach' }));
      expect(sent(socket).at(-1)).toEqual({ type: 'open', sessionId: BG, cols: 80, rows: 24, restart: true });
      // Busy until the attach has started: the button says so, Cancel is off, and Escape changes nothing.
      const busy = within(confirm).getByRole('button', { name: 'Restarting…' });
      expect(busy.getAttribute('aria-busy')).toBe('true');
      expect(within(confirm).getByRole('button', { name: 'Cancel' }).getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(busy);
      fireEvent.keyDown(busy, { key: 'Escape' });
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(sent(socket).filter((message) => message.restart === true)).toHaveLength(1);
      expect(screen.getByRole('dialog', { name: 'demo-worker' })).toBe(view);
      act(() => socket.receive({ type: 'attached' }));
      expect(within(view).queryByRole('alertdialog')).toBeNull();
      expect(within(view).getByRole('status').textContent).toBe('Attached');
    });

    it('when the restart fails, the confirmation goes and Attach again takes focus', async () => {
      const { view, socket } = await needingRestart();
      fireEvent.click(within(within(view).getByRole('alertdialog')).getByRole('button', { name: 'Restart and attach' }));
      act(() => socket.receive({ type: 'error', error: 'made up for the test.' }));
      expect(within(view).queryByRole('alertdialog')).toBeNull();
      expect(document.activeElement).toBe(within(view).getByRole('button', { name: 'Attach again' }));
    });

    it("says a session that's still starting is starting, never asks to restart it, and can try again", async () => {
      const { fake } = renderDashboard(snap([background({ pid: undefined, alive: false, status: undefined, state: 'working' })]));
      const view = await openView('demo-worker');
      const { socket } = await attach(view, fake);
      await ready(socket);
      act(() => socket.receive({ type: 'error', error: 'This session is still starting. Try again in a moment.' }));
      expect(within(view).queryByRole('alertdialog')).toBeNull();
      expect(within(view).getByRole('alert').textContent).toBe("Couldn't attach: This session is still starting. Try again in a moment.");
      expect(sent(socket).some((message) => message.restart !== undefined)).toBe(false);
      fireEvent.click(within(view).getByRole('button', { name: 'Attach again' }));
      await waitFor(() => expect(fake.sockets).toHaveLength(2));
    });

    it('cancelling closes the socket without restarting, and goes back to the conversation', async () => {
      const { view, socket, terminal } = await needingRestart();
      fireEvent.click(within(within(view).getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
      expect(socket.closedByClient).toBe(true);
      expect(terminal.disposed).toBe(true);
      expect(sent(socket).some((message) => message.restart === true)).toBe(false);
      expect(view.querySelector<HTMLElement>('.session-view-body')!.hidden).toBe(false);
      expect(document.activeElement).toBe(tab(view, 'Terminal'));
    });

    it('Escape cancels the restart, wherever focus is, and only a second Escape closes the view', async () => {
      const { view, socket } = await needingRestart();
      fireEvent.keyDown(tab(view, 'Terminal'), { key: 'Escape' });
      expect(socket.closedByClient).toBe(true);
      expect(sent(socket).some((message) => message.restart === true)).toBe(false);
      expect(within(view).queryByRole('alertdialog')).toBeNull();
      expect(screen.getByRole('dialog')).toBe(view);

      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
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
    expect(notice(view)?.textContent).toBe('claude attach ended.');
    expect(within(view).queryByRole('alert')).toBeNull();
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

describe('SessionView: the terminal bar, its notices and F6 (W29)', () => {
  /** The badge's look, lead and label, and the bar's buttons by name, as each is drawn. */
  function bar(view: HTMLElement) {
    const badge = statusBadge(view);
    const look = [...badge.classList].find((name) => name.startsWith('badge-'));
    const lead = badge.querySelector('.spinner') ? 'spinner' : badge.querySelector('.status-dot') ? 'dot' : undefined;
    const buttons = [...view.querySelectorAll<HTMLButtonElement>('.attach-bar button')].map((button) => `${button.textContent} (${button.className})`);
    return { look, lead, label: badge.querySelector('.badge-label')?.textContent, buttons };
  }

  it('Attaching…: a subtle neutral badge with a spinner, the F6 hint, and a ghost sm Detach', async () => {
    const { fake } = renderDashboard();
    const view = await openView('demo-worker');
    await attach(view, fake);
    expect(bar(view)).toEqual({ look: 'badge-subtle-neutral', lead: 'spinner', label: 'Attaching…', buttons: ['Detach (button ghost sm)'] });
    // The badge sits in a status region, so each change is announced.
    expect(statusBadge(view).closest('[role="status"]')?.closest('.attach-bar')).not.toBeNull();
    const hint = view.querySelector<HTMLElement>('.attach-hint')!;
    expect(hint.textContent).toBe('F6F6 to leave the terminal');
    expect(within(hint).getByText('F6', { selector: 'kbd' }).closest('[aria-hidden="true"]')).not.toBeNull();
    expect(within(hint).getByText('F6', { selector: '.visually-hidden' })).toBeTruthy();
    expect(notice(view)).toBeNull();
  });

  it("gives xterm.js the F6 hint's id, to describe its textarea, and sends the new size when a late font resizes the cells (W31)", async () => {
    const { fake } = renderDashboard();
    const view = await openView('demo-worker');
    const { socket } = await attach(view, fake);
    await ready(socket);
    act(() => socket.receive({ type: 'attached' }));
    const hint = view.querySelector<HTMLElement>('.attach-hint')!;
    expect(hint.id).not.toBe('');
    expect(created.at(-1)?.describedBy).toBe(hint.id);
    act(() => created.at(-1)?.onResize?.(96, 30));
    expect(sent(socket).at(-1)).toEqual({ type: 'resize', cols: 96, rows: 30 });
  });

  it('Attached: a subtle success badge with a dot, the hint, and Detach', async () => {
    const { fake } = renderDashboard();
    const view = await openView('demo-worker');
    const { socket } = await attach(view, fake);
    await ready(socket);
    act(() => socket.receive({ type: 'attached' }));
    expect(bar(view)).toEqual({ look: 'badge-subtle-success', lead: 'dot', label: 'Attached', buttons: ['Detach (button ghost sm)'] });
    expect(view.querySelector('.attach-hint')).not.toBeNull();
  });

  it('Detached: a subtle neutral badge with no lead, then a ghost sm Attach again with the retry icon, and Back to the conversation', async () => {
    const { fake } = renderDashboard();
    const view = await openView('demo-worker');
    const { socket } = await attach(view, fake);
    await ready(socket);
    act(() => socket.receive({ type: 'attached' }));
    act(() => socket.receive({ type: 'exit', code: 0 }));
    expect(bar(view)).toEqual({
      look: 'badge-subtle-neutral',
      lead: undefined,
      label: 'Detached',
      buttons: ['Attach again (button ghost sm)', 'Back to the conversation (button ghost sm)'],
    });
    const again = within(view).getByRole('button', { name: 'Attach again' });
    expect(again.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(view.querySelector('.attach-hint')).not.toBeNull();
  });

  it('Not running: an outline badge while it asks to restart', async () => {
    const { fake } = renderDashboard(snap([background({ pid: undefined, alive: false, status: undefined, state: 'done', finished: true })]));
    fireEvent.click(screen.getByRole('button', { name: 'Finished (1)', expanded: false }));
    const view = await openView('demo-worker');
    const { socket } = await attach(view, fake);
    await ready(socket);
    act(() => socket.receive({ type: 'needs-restart' }));
    expect(bar(view)).toEqual({ look: 'badge-outline', lead: undefined, label: 'Not running', buttons: ['Detach (button ghost sm)'] });
  });

  describe('notices: an inline alert above the screen', () => {
    async function ended(end: (socket: FakeSocket) => void) {
      const { fake } = renderDashboard();
      const view = await openView('demo-worker');
      const { socket } = await attach(view, fake);
      await ready(socket);
      act(() => socket.receive({ type: 'attached' }));
      act(() => end(socket));
      return view;
    }

    /** The notice's tone, role, icon and text, and whether it's above the screen. */
    function described(view: HTMLElement) {
      const alert = notice(view)!;
      const tone = ['neutral', 'danger', 'info', 'success', 'warning'].find((name) => alert.classList.contains(name));
      const screenElement = view.querySelector('.attach-terminal')!;
      return {
        alert: alert.classList.contains('inline-alert'),
        tone,
        role: alert.getAttribute('role'),
        icon: alert.querySelector(':scope > svg') !== null,
        above: Boolean(alert.compareDocumentPosition(screenElement) & Node.DOCUMENT_POSITION_FOLLOWING),
        text: alert.textContent,
      };
    }

    it('neutral, as a status, when claude attach ended cleanly, as it does when you detach inside it', async () => {
      const view = await ended((socket) => socket.receive({ type: 'exit', code: 0 }));
      expect(described(view)).toEqual({ alert: true, tone: 'neutral', role: 'status', icon: true, above: true, text: 'claude attach ended.' });
      expect(view.querySelector('.banner')).toBeNull();
    });

    it('danger, as an alert, when it failed: the server refused, it exited with an error, too many attached, or the connection closed', async () => {
      const cases: [string, (socket: FakeSocket) => void, string][] = [
        ['refused', (socket) => socket.receive({ type: 'error', error: 'Only background sessions can be attached.' }), "Couldn't attach: Only background sessions can be attached."],
        ['exit 1', (socket) => socket.receive({ type: 'exit', code: 1 }), 'claude attach ended with exit code 1.'],
        ['too many', (socket) => socket.serverClose(WS_CLOSE_TOO_MANY), '4 sessions are already attached; detach one first.'],
        ['closed', (socket) => socket.serverClose(1006), 'The connection to pitwall closed, so this terminal is detached.'],
      ];
      for (const [name, end, text] of cases) {
        const view = await ended(end);
        expect(described(view), name).toEqual({ alert: true, tone: 'danger', role: 'alert', icon: true, above: true, text });
        cleanup();
      }
    });

    it("shows the server's reason as text, never markup, and without terminal escapes", async () => {
      const view = await ended((socket) => socket.receive({ type: 'error', error: '<b>made up</b>\u001b[31m reason' }));
      expect(notice(view)!.textContent).toBe("Couldn't attach: <b>made up</b> reason");
      expect(notice(view)!.querySelector('b')).toBeNull();
    });

    it("puts the server's reason in code style, apart from pitwall's words, and claude attach in code style too (W31)", async () => {
      let view = await ended((socket) => socket.receive({ type: 'error', error: 'Only background sessions can be attached.' }));
      expect(notice(view)!.querySelector('.alert-detail')?.textContent).toBe('Only background sessions can be attached.');
      cleanup();
      view = await ended((socket) => socket.receive({ type: 'exit', code: 1 }));
      expect(notice(view)!.textContent).toBe('claude attach ended with exit code 1.');
      expect(notice(view)!.querySelector('code')?.textContent).toBe('claude attach');
      expect(notice(view)!.querySelector('.alert-detail')).toBeNull();
    });
  });

  describe('F6 leaves the terminal, and every other key stays in it', () => {
    async function attached() {
      const { fake } = renderDashboard();
      const view = await openView('demo-worker');
      const { socket, terminal } = await attach(view, fake);
      await ready(socket);
      act(() => socket.receive({ type: 'attached' }));
      expect(document.activeElement).toBe(terminal.screen);
      return { view, socket, terminal };
    }

    it('F6 moves focus to the Terminal tab, never reaches the session, and leaves the terminal attached', async () => {
      const { view, socket, terminal } = await attached();
      const before = socket.sent.length;
      const event = fireEvent.keyDown(terminal.screen, { key: 'F6' });
      expect(event).toBe(false);
      expect(document.activeElement).toBe(tab(view, 'Terminal'));
      expect(terminal.keys).toEqual([]);
      expect(socket.sent).toHaveLength(before);
      expect(socket.closedByClient).toBe(false);
      expect(terminal.disposed).toBe(false);
      expect(tab(view, 'Terminal').getAttribute('aria-selected')).toBe('true');
      expect(screen.getByRole('dialog')).toBe(view);
    });

    it('Escape, Tab, letters and F6 with a modifier all reach the terminal, and Escape leaves the view open', async () => {
      const { view, socket, terminal } = await attached();
      for (const init of [{ key: 'Escape' }, { key: 'Tab' }, { key: 'j' }, { key: 'k' }, { key: 'F6', shiftKey: true }, { key: 'F5' }]) {
        fireEvent.keyDown(terminal.screen, init);
      }
      expect(terminal.keys).toEqual(['Escape', 'Tab', 'j', 'k', 'Shift+F6', 'F5']);
      expect(document.activeElement).toBe(terminal.screen);
      expect(screen.getByRole('dialog')).toBe(view);
      expect(socket.closedByClient).toBe(false);
      expect(tab(view, 'Terminal').getAttribute('aria-selected')).toBe('true');
    });

    it('F6 outside the screen, such as on the bar, does nothing of its own', async () => {
      const { view, terminal } = await attached();
      const detach = within(view).getByRole('button', { name: 'Detach' });
      detach.focus();
      fireEvent.keyDown(detach, { key: 'F6' });
      expect(document.activeElement).toBe(detach);
      expect(terminal.keys).toEqual([]);
    });
  });
});

describe("SessionView: Shift+Enter, a new line in Claude Code's prompt (W41)", () => {
  async function attached() {
    const { fake } = renderDashboard();
    const view = await openView('demo-worker');
    const { socket, terminal } = await attach(view, fake);
    await ready(socket);
    act(() => socket.receive({ type: 'attached' }));
    expect(document.activeElement).toBe(terminal.screen);
    return { view, socket, terminal, from: socket.sent.length };
  }

  /** The input the session got since `from`, one entry for each message. */
  const inputs = (socket: FakeSocket, from: number) => sent(socket).slice(from).map((message) => (message.type === 'input' ? message.data : message.type));

  const ENTER = { key: 'Enter', code: 'Enter', keyCode: 13 };

  it('Enter goes to xterm.js, which sends a carriage return', async () => {
    const { socket, terminal, from } = await attached();
    expect(fireEvent.keyDown(terminal.screen, ENTER)).toBe(true);
    expect(terminal.keys).toEqual(['Enter']);
    expect(inputs(socket, from)).toEqual(['\r']);
  });

  it('Shift+Enter sends one line feed and no carriage return, taken before xterm.js sees it', async () => {
    const { view, socket, terminal, from } = await attached();
    expect(NEW_LINE).toBe('\n');
    // Cancelled, so no keypress or input follows it into xterm.js's textarea.
    expect(fireEvent.keyDown(terminal.screen, { ...ENTER, shiftKey: true })).toBe(false);
    expect(terminal.keys).toEqual([]);
    expect(sent(socket).slice(from)).toEqual([{ type: 'input', data: '\n' }]);
    expect(inputs(socket, from).join('')).not.toContain('\r');
    // It stays in the terminal: focus, the open view, the Terminal tab and the attach.
    expect(document.activeElement).toBe(terminal.screen);
    expect(screen.getByRole('dialog')).toBe(view);
    expect(tab(view, 'Terminal').getAttribute('aria-selected')).toBe('true');
    expect(socket.closedByClient).toBe(false);
    expect(terminal.disposed).toBe(false);
  });

  it('held down, Shift+Enter repeats as Enter does: one line feed for each keydown', async () => {
    const { socket, terminal, from } = await attached();
    for (const repeat of [false, true, true]) fireEvent.keyDown(terminal.screen, { ...ENTER, shiftKey: true, repeat });
    expect(inputs(socket, from)).toEqual(['\n', '\n', '\n']);
    expect(terminal.keys).toEqual([]);
    const after = socket.sent.length;
    for (const repeat of [false, true, true]) fireEvent.keyDown(terminal.screen, { ...ENTER, repeat });
    expect(inputs(socket, after)).toEqual(['\r', '\r', '\r']);
  });

  it('Shift+Enter with Ctrl, Alt or ⌘ goes to xterm.js like any other key', async () => {
    const { socket, terminal, from } = await attached();
    for (const held of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { ctrlKey: true, altKey: true, metaKey: true }]) {
      expect(fireEvent.keyDown(terminal.screen, { ...ENTER, shiftKey: true, ...held })).toBe(true);
    }
    expect(terminal.keys).toEqual(['Ctrl+Shift+Enter', 'Alt+Shift+Enter', 'Meta+Shift+Enter', 'Ctrl+Alt+Meta+Shift+Enter']);
    expect(inputs(socket, from)).toEqual(['\r', '\u001b\r', '\r', '\u001b\r']);
  });

  it('while an input method composes, every key goes to xterm.js, Shift+Enter and Enter included', async () => {
    const { socket, terminal, from } = await attached();
    const composing = [
      { key: 'Process', code: 'KeyK', keyCode: 229, isComposing: true },
      { ...ENTER, shiftKey: true, isComposing: true },
      { ...ENTER, isComposing: true },
      // Safari: the key that ends a composition comes after compositionend, so isComposing is false, with keyCode 229.
      { ...ENTER, keyCode: 229, shiftKey: true },
    ];
    for (const init of composing) expect(fireEvent.keyDown(terminal.screen, init)).toBe(true);
    expect(terminal.keys).toEqual(['Process', 'Shift+Enter', 'Enter', 'Shift+Enter']);
    expect(inputs(socket, from)).not.toContain('\n');
    expect(inputs(socket, from)).toEqual(['\r', '\r']);
  });

  it('F6 and Escape are as they were, next to Shift+Enter', async () => {
    const { view, socket, terminal, from } = await attached();
    fireEvent.keyDown(terminal.screen, { ...ENTER, shiftKey: true });
    fireEvent.keyDown(terminal.screen, { key: 'Escape' });
    expect(terminal.keys).toEqual(['Escape']);
    expect(screen.getByRole('dialog')).toBe(view);
    expect(fireEvent.keyDown(terminal.screen, { key: 'F6' })).toBe(false);
    expect(document.activeElement).toBe(tab(view, 'Terminal'));
    expect(terminal.keys).toEqual(['Escape']);
    expect(inputs(socket, from)).toEqual(['\n']);
  });

  it('outside the screen, on the Terminal tab or the bar, Shift+Enter does nothing of its own', async () => {
    const { view, socket, terminal, from } = await attached();
    fireEvent.keyDown(terminal.screen, { key: 'F6' });
    const termTab = tab(view, 'Terminal');
    expect(document.activeElement).toBe(termTab);
    fireEvent.keyDown(termTab, { ...ENTER, shiftKey: true });
    const detach = within(view).getByRole('button', { name: 'Detach' });
    detach.focus();
    fireEvent.keyDown(detach, { ...ENTER, shiftKey: true });
    expect(terminal.keys).toEqual([]);
    expect(socket.sent.length).toBe(from);
    expect(termTab.getAttribute('aria-selected')).toBe('true');
    expect(socket.closedByClient).toBe(false);
  });

  it('before the attach has started, Shift+Enter still never reaches xterm.js, and sends nothing', async () => {
    const { fake } = renderDashboard();
    const view = await openView('demo-worker');
    const { socket, terminal } = await attach(view, fake);
    expect(fireEvent.keyDown(terminal.screen, { ...ENTER, shiftKey: true })).toBe(false);
    expect(terminal.keys).toEqual([]);
    await ready(socket);
    act(() => socket.receive({ type: 'attached' }));
    expect(sent(socket).map((message) => message.type)).toEqual(['auth', 'open']);
  });
});

describe('App: attach', () => {
  it('opens a session from the URL without attaching', async () => {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, TOKEN);
    window.history.replaceState(null, '', `/?view=all&session=${BG}`);
    const fake = fakeSockets();
    render(<App createSocket={fake.factory} fetch={emptyPages} />);
    act(() => {
      fake.last.open();
      fake.last.receive({ type: 'challenge', version: PROTOCOL_VERSION, nonce: nonce(1) });
    });
    await waitFor(() => expect(fake.last.sent).toHaveLength(1));
    act(() => fake.last.receive({ type: 'authenticated', apiKey: API_KEY }));
    act(() => fake.last.receive({ type: 'snapshot', snapshot: snap() }));
    await settle();

    const view = screen.getByRole('dialog', { name: 'demo-worker' });
    expect(tab(view, 'Conversation').getAttribute('aria-selected')).toBe('true');
    // Only the index's socket: nothing attached.
    expect(fake.sockets).toHaveLength(1);
  });

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

    const view = await openView('demo-worker');
    const { socket } = await attach(view, fake);
    expect(socket.url).toBe(`ws://${window.location.host}${ATTACH_PATH}`);
    await ready(socket, nonce(2));
    expect(sent(socket)[0]).toEqual({ type: 'auth', proof: await computeProof(TOKEN, nonce(2)) });
    for (const each of fake.sockets) for (const data of each.sent) expect(data).not.toContain(TOKEN);
    for (const [url, init] of emptyPages.mock.calls) expect(`${url} ${JSON.stringify(init)}`).not.toContain(TOKEN);
  });
});
