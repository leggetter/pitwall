// Running background sessions open on the Terminal tab (W54): which tab a view opens on, for each kind
// and state, from a click, ?session=, the back button and a reload, and with Preferences on
// Conversation; a tab you chose staying chosen; where focus goes as the terminal attaches; stepping with
// j, k, ↑ and ↓, which waits before attaching, so passing through attaches nothing; the four-attach
// limit (D9); and the setting in the Preferences dialog (W59), and its storage. Made-up sessions only, and fake sockets: nothing
// here reaches a session.
//
// And W57: the terminal takes the keyboard only right after a click or Enter in the page opened the
// view or its Terminal tab, or asked to attach again, never from the URL, a reload, back or forward, a
// root tab or a step, with a hint in its bar when it hasn't; and the setting that can make it never.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ATTACH_PATH,
  MAX_ATTACHED,
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
import { BACKGROUND_TAB_KEY, readBackgroundTab, writeBackgroundTab } from '../backgroundTab.js';
import { browserStorage, type StorageSource } from '../groupState.js';
import { GESTURE_MS } from '../focusGesture.js';
import { computeProof } from '../proof.js';
import { TERMINAL_FOCUS_KEY } from '../terminalFocus.js';
import { fakeSockets, group, minutesAgo, NOW, session, snapshot, type FakeSocket, withoutSubagents } from '../test/fixtures.js';
import { fakeHistory } from '../test/history.js';
import { choosePreference, openPreferences, preferenceGroup, preferenceOption, preferenceOptions, preferencesButton, preferencesDialog } from '../test/preferences.js';
import { toastMessages } from '../test/toasts.js';
import { ATTACH_DELAY_MS } from '../timing.js';
import { TOKEN_STORAGE_KEY } from '../token.js';
import { Dashboard, listedText } from './Dashboard.js';
import { SessionView } from './SessionView.js';
import { TYPE_HINT, type TerminalHandle } from './Terminal.js';

// xterm.js, replaced by a terminal whose screen is a textarea, so where focus goes can be seen. A key
// pressed on the screen goes to the session as xterm.js would send it, so a key that reaches the
// session shows on the attach socket (W57).
class FakeTerminal implements TerminalHandle {
  cols = 80;
  rows = 24;
  disposed = false;
  readonly screen: HTMLTextAreaElement;
  private listeners: ((data: string) => void)[] = [];
  constructor(container: HTMLElement) {
    this.screen = document.createElement('textarea');
    this.screen.className = 'fake-terminal';
    this.screen.addEventListener('keydown', (event) => {
      const data = event.key === 'Enter' ? '\r' : event.key.length === 1 ? event.key : undefined;
      if (data !== undefined) for (const listener of this.listeners) listener(data);
    });
    container.append(this.screen);
  }
  write() {}
  onData(listener: (data: string) => void) {
    this.listeners.push(listener);
  }
  fit() {}
  focus() {
    this.screen.focus();
  }
  dispose() {
    this.disposed = true;
    this.screen.remove();
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

const API_KEY = 'k'.repeat(43);
const TOKEN = 'pitwall-test-token-0123456789abcdefghijklmnop';
const NONCE = 'n'.repeat(43);
const id = (n: number) => `00000000-0000-4000-8000-0000000054${String(n).padStart(2, '0')}`;
const A = id(1);
const J1 = id(2);
const J2 = id(3);
const J3 = id(4);
const C = id(5);
const EXITED = id(6);
const DONE = id(7);

/** A running background session. */
const job = (n: number, name: string, extra: Partial<SessionSummary> = {}) =>
  session({ sessionId: id(n), name, kind: 'background', shortId: `pt54${String(n).padStart(2, '0')}`, state: 'working', status: undefined, lastActivityAt: minutesAgo(n), ...extra });

/**
 * In the order shown: demo-a, interactive; job-one, job-two and job-three, running background
 * sessions; demo-c, interactive; job-exited, whose process exited before it finished; and job-done,
 * finished, in the collapsed Finished section.
 */
function sessions(): SessionSummary[] {
  return [
    session({ sessionId: A, name: 'demo-a', lastActivityAt: minutesAgo(1) }),
    job(2, 'job-one'),
    job(3, 'job-two'),
    job(4, 'job-three'),
    session({ sessionId: C, name: 'demo-c', lastActivityAt: minutesAgo(5) }),
    job(6, 'job-exited', { alive: false, pid: undefined }),
    job(7, 'job-done', { state: 'done', alive: false, pid: undefined, finished: true }),
  ];
}
const snap = (list: SessionSummary[] = sessions()): IndexSnapshot => snapshot([group({ sessions: list })]);

/** The session New session starts, which a test then lists (W57). */
const STARTED = { shortId: 'pt5799', name: 'job-new' };

/** Every GET is a conversation page of one entry; New session starts STARTED; every other POST is refused. All are recorded. */
function fakeServer() {
  return vi.fn<FetchLike>(async (url, init) => {
    if (init.method === 'POST' && url === '/api/sessions') return new Response(JSON.stringify({ ok: true, ...STARTED }), { status: 201 });
    if (init.method === 'POST') return new Response(JSON.stringify({ ok: false, error: 'not in this test' }), { status: 409 });
    const sessionId = decodeURIComponent(url.split('/')[3] ?? '');
    const page: ConversationPage = { sessionId, entries: [{ kind: 'assistant', text: `made-up reply from ${sessionId.slice(-2)}` }] };
    return new Response(JSON.stringify(page), { status: 200 });
  });
}

function memory(entries: Record<string, string> = {}): StorageSource & { values: Map<string, string> } {
  const values = new Map(Object.entries(entries));
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
  return Object.assign(() => storage, { values });
}

interface Options {
  search?: string;
  storage?: StorageSource;
  /** False renders without a way to attach, as some tests of the app do. */
  attach?: boolean;
}

function renderDashboard(first: IndexSnapshot = snap(), options: Options = {}) {
  const history = fakeHistory(options.search ?? '?view=all');
  const fetch = fakeServer();
  const api = createApiClient({ apiKey: API_KEY, fetch: withoutSubagents(fetch) });
  const sockets = fakeSockets();
  const env: AttachEnv = { token: TOKEN, createSocket: sockets.factory, host: '127.0.0.1:4517' };
  const storage = options.storage ?? memory();
  const ui = (s: IndexSnapshot) => {
    const dashboard = <Dashboard view={{ state: 'live', snapshot: s }} navigation={history.navigation} storage={storage} />;
    return <ApiContext.Provider value={api}>{options.attach === false ? dashboard : <AttachContext.Provider value={env}>{dashboard}</AttachContext.Provider>}</ApiContext.Provider>;
  };
  const result = render(ui(first));
  return { ...result, history, fetch, sockets, storage, update: (next: IndexSnapshot) => result.rerender(ui(next)) };
}

function setWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

const settle = () => act(async () => {});
/** One turn of the event loop, in which real I/O that has finished, such as WebCrypto's proof, comes back, while fake timers stand still. */
const io = () => act(() => new Promise<void>((resolve) => setImmediate(resolve)));
/**
 * How long until() waits, by the real clock, which no test fakes. Real I/O takes time rather than turns: WebCrypto's
 * proof runs on Node's thread pool, which a loaded machine can keep waiting while the event loop turns 200 times in
 * a few tens of milliseconds (W60). It's under the 5 seconds a test may take, so a wait that fails says so itself.
 */
const UNTIL_MS = 4000;
/** Waits for `done`, a turn of the event loop at a time, without timers, for the tests that fake them. */
async function until(done: () => boolean, what: string) {
  const deadline = performance.now() + UNTIL_MS;
  while (!done() && performance.now() < deadline) await io();
  expect(done(), `still waiting for ${what} after ${UNTIL_MS / 1000} s`).toBe(true);
}
/** Moves the fake clock on, running what falls due and what that awaits. */
const pass = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

const rowButton = (name: string) => within(screen.getByRole('main')).getByRole('button', { name });
async function open(name: string) {
  fireEvent.click(rowButton(name));
  await settle();
}
const view = () => (document.getElementById('session-view') as HTMLElement | null) ?? undefined;
const viewName = () => view()?.querySelector('.session-view-name')?.textContent ?? undefined;
const heading = () => document.getElementById(view()!.getAttribute('aria-labelledby')!)!;
const tab = (name: 'Conversation' | 'Terminal') => within(view()!).getByRole('tab', { name: new RegExp(`^${name}`) });
/** The tab the open view shows. */
const shownTab = () => (tab('Terminal').getAttribute('aria-selected') === 'true' ? 'Terminal' : 'Conversation');
const conversationPanel = () => view()!.querySelector<HTMLElement>('.session-view-body[role="tabpanel"]')!;
const footerNote = () => view()!.querySelector('.session-view-note')?.textContent;
const attachStatus = () => view()!.querySelector('.attach-status')?.textContent;
const posts = (fetch: ReturnType<typeof fakeServer>) => fetch.mock.calls.filter(([, init]) => init.method === 'POST');
const sent = (socket: FakeSocket) => socket.sent.map((data) => JSON.parse(data) as Record<string, unknown>);
const press = (key: string, target: Element | null = document.activeElement) => fireEvent.keyDown(target ?? document.body, { key });
/** What reached the session through an attach socket: each input message's data (W57). */
const inputs = (socket: FakeSocket) => sent(socket).flatMap((message) => (message.type === 'input' ? [message.data] : []));
/** Whether the latest terminal's screen has focus, so a key pressed now would reach its session. */
const terminalHasFocus = () => terminals.at(-1)?.screen.isConnected === true && document.activeElement === terminals.at(-1)?.screen;
/** The terminal bar's hint that shows, F6's or how to type to it, by its text. */
const shownHint = () => view()?.querySelector<HTMLElement>('.attach-hints [data-shown="true"]')?.textContent ?? undefined;

/** New session, from its header button, with a made-up first prompt: the fake server starts STARTED. */
async function startSession() {
  const button = screen.getByRole('button', { name: 'New session' });
  // A click focuses the button in a browser, and the dialog gives focus back to it as it closes.
  button.focus();
  fireEvent.click(button);
  const dialog = screen.getByRole('dialog', { name: 'New session' });
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'First prompt' }), { target: { value: 'A made-up first prompt.' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Start session' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New session' })).toBeNull());
}

/** The attach server's side of the handshake, as far as `attached`, with real timers. */
async function attachIt(socket: FakeSocket) {
  act(() => {
    socket.open();
    socket.receive({ type: 'challenge', version: PROTOCOL_VERSION, nonce: NONCE });
  });
  await waitFor(() => expect(socket.sent).toHaveLength(1));
  act(() => socket.receive({ type: 'ready' }));
  act(() => socket.receive({ type: 'attached' }));
}

/** The same, with fake timers. */
async function attachQuietly(socket: FakeSocket) {
  act(() => {
    socket.open();
    socket.receive({ type: 'challenge', version: PROTOCOL_VERSION, nonce: NONCE });
  });
  await until(() => socket.sent.length === 1, 'the page to answer the challenge');
  act(() => socket.receive({ type: 'ready' }));
  act(() => socket.receive({ type: 'attached' }));
}

beforeEach(() => {
  terminals.length = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  setWidth(1440);
});

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
});

describe('the tab a view opens on', () => {
  it('is Terminal for a running background session, from a click (or Enter, a button’s click), and it attaches; the conversation is behind it, and the footer’s note with it', async () => {
    const { sockets } = renderDashboard();
    await open('job-one');
    expect(shownTab()).toBe('Terminal');
    expect(tab('Conversation').getAttribute('aria-selected')).toBe('false');
    expect([tab('Conversation').tabIndex, tab('Terminal').tabIndex]).toEqual([-1, 0]);
    expect(conversationPanel().hidden).toBe(true);
    expect(footerNote()).toBeUndefined();
    await waitFor(() => expect(sockets.sockets).toHaveLength(1));
    expect(sockets.last.url).toBe(`ws://127.0.0.1:4517${ATTACH_PATH}`);
    await attachIt(sockets.last);
    expect(sent(sockets.last)[1]).toEqual({ type: 'open', sessionId: J1, cols: 80, rows: 24 });
    expect(attachStatus()).toBe('Attached');
  });

  it('is Conversation for an interactive session, for a background one whose process has exited, and for a finished one, and nothing attaches', async () => {
    const { sockets } = renderDashboard();
    await open('demo-a');
    expect(shownTab()).toBe('Conversation');
    await open('job-exited');
    expect(shownTab()).toBe('Conversation');
    // Attaching would restart it, which the Terminal tab asks first.
    expect(footerNote()).toBe('To message it, open its Terminal tab, which asks before restarting it.');
    fireEvent.click(screen.getByRole('button', { name: 'Finished (1)', expanded: false }));
    await open('job-done');
    expect(shownTab()).toBe('Conversation');
    expect(conversationPanel().hidden).toBe(false);
    await settle();
    expect(sockets.sockets).toHaveLength(0);
  });

  it('is Conversation wherever the Terminal tab is off: with no way to attach here, or once the session is no longer listed', async () => {
    const off = renderDashboard(snap(), { attach: false });
    await open('job-one');
    expect(shownTab()).toBe('Conversation');
    expect(tab('Terminal').getAttribute('aria-disabled')).toBe('true');
    off.unmount();

    const { sockets, update, history } = renderDashboard();
    await open('job-two');
    await waitFor(() => expect(sockets.sockets).toHaveLength(1));
    await open('demo-a');
    expect(sockets.sockets[0]?.closedByClient).toBe(true);
    update(snap(sessions().filter((each) => each.sessionId !== J2)));
    history.back();
    await settle();
    expect(viewName()).toBe('job-two');
    expect(within(view()!).getByText('This session is no longer listed, so this is what it showed last.')).toBeTruthy();
    expect(shownTab()).toBe('Conversation');
    expect(tab('Terminal').getAttribute('aria-disabled')).toBe('true');
    expect(sockets.sockets).toHaveLength(1);
  });

  it('is Terminal for a running background session a ?session= names on load, which attaches, and nothing else: no message, no stop or remove, and no focus taken before it attaches', async () => {
    const { sockets, fetch } = renderDashboard(snap(), { search: `?view=all&session=${J1}` });
    await settle();
    expect(viewName()).toBe('job-one');
    expect(shownTab()).toBe('Terminal');
    await waitFor(() => expect(sockets.sockets).toHaveLength(1));
    expect(posts(fetch)).toEqual([]);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([`/api/sessions/${J1}/conversation`]);
    expect(document.activeElement).toBe(document.body);
  });

  it('is Conversation for the interactive, exited and finished sessions a ?session= names on load', async () => {
    for (const [sessionId, name] of [
      [A, 'demo-a'],
      [EXITED, 'job-exited'],
      [DONE, 'job-done'],
    ] as const) {
      const { sockets, unmount } = renderDashboard(snap(), { search: `?view=all&session=${sessionId}` });
      await settle();
      expect(viewName()).toBe(name);
      expect(shownTab()).toBe('Conversation');
      expect(sockets.sockets).toHaveLength(0);
      unmount();
    }
  });

  it('is Terminal again when the back or forward button returns to a running background session', async () => {
    const { sockets, history } = renderDashboard();
    await open('job-one');
    await waitFor(() => expect(sockets.sockets).toHaveLength(1));
    await open('demo-a');
    expect(shownTab()).toBe('Conversation');
    history.back();
    await settle();
    expect(viewName()).toBe('job-one');
    expect(shownTab()).toBe('Terminal');
    await waitFor(() => expect(sockets.sockets).toHaveLength(2));
    history.forward();
    await settle();
    expect(viewName()).toBe('demo-a');
    expect(sockets.sockets[1]?.closedByClient).toBe(true);
  });

  it('is Terminal after a reload, which attaches with the token the tab holds, sending only proofs', async () => {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, TOKEN);
    window.history.replaceState(null, '', `/?view=all&session=${J1}`);
    const fake = fakeSockets();
    const fetch = fakeServer();
    render(<App createSocket={fake.factory} fetch={withoutSubagents(fetch)} />);
    const index = fake.last;
    expect(index.url).toContain(WS_PATH);
    act(() => {
      index.open();
      index.receive({ type: 'challenge', version: PROTOCOL_VERSION, nonce: NONCE });
    });
    await waitFor(() => expect(index.sent).toHaveLength(1));
    act(() => index.receive({ type: 'authenticated', apiKey: API_KEY }));
    act(() => index.receive({ type: 'snapshot', snapshot: snap() }));
    await settle();

    expect(viewName()).toBe('job-one');
    expect(shownTab()).toBe('Terminal');
    await waitFor(() => expect(fake.sockets).toHaveLength(2));
    const attach = fake.last;
    expect(attach.url).toBe(`ws://${window.location.host}${ATTACH_PATH}`);
    await attachIt(attach);
    expect(sent(attach)[0]).toEqual({ type: 'auth', proof: await computeProof(TOKEN, NONCE) });
    for (const each of fake.sockets) for (const data of each.sent) expect(data).not.toContain(TOKEN);
    for (const [url, init] of fetch.mock.calls) expect(`${url} ${JSON.stringify(init)}`).not.toContain(TOKEN);
    expect(posts(fetch)).toEqual([]);
  });

  it('is Conversation with Preferences on Conversation, from a click, a ?session= and the back button, and nothing attaches', async () => {
    const storage = memory({ [BACKGROUND_TAB_KEY]: 'conversation' });
    const { sockets, history } = renderDashboard(snap(), { storage });
    await open('job-one');
    expect(shownTab()).toBe('Conversation');
    expect(footerNote()).toBe('To message it, type in its Terminal tab, which attaches to it.');
    await open('demo-a');
    history.back();
    await settle();
    expect(viewName()).toBe('job-one');
    expect(shownTab()).toBe('Conversation');
    await settle();
    expect(sockets.sockets).toHaveLength(0);

    const loaded = renderDashboard(snap(), { storage, search: `?view=all&session=${J2}` });
    await settle();
    expect(shownTab()).toBe('Conversation');
    expect(loaded.sockets.sockets).toHaveLength(0);
  });
});

describe('a tab you chose', () => {
  it('stays chosen whatever the session does after: Conversation, chosen on a running one, through it waiting on you', async () => {
    const { sockets, update } = renderDashboard();
    await open('job-one');
    await waitFor(() => expect(sockets.sockets).toHaveLength(1));
    fireEvent.click(tab('Conversation'));
    expect(sockets.last.closedByClient).toBe(true);
    update(snap(sessions().map((each) => (each.sessionId === J1 ? { ...each, status: 'waiting', waitingFor: 'permission prompt' } : each))));
    await settle();
    expect(viewName()).toBe('job-one');
    expect(shownTab()).toBe('Conversation');
    expect(sockets.sockets).toHaveLength(1);
  });

  it('isn’t switched for you: a view on Terminal stays there as its session finishes, and one on Conversation stays there as its session runs again', async () => {
    const { sockets, update } = renderDashboard();
    await open('job-one');
    await waitFor(() => expect(sockets.sockets).toHaveLength(1));
    update(snap(sessions().map((each) => (each.sessionId === J1 ? { ...each, state: 'done', alive: false, pid: undefined, finished: true } : each))));
    await settle();
    expect(shownTab()).toBe('Terminal');
    expect(sockets.last.closedByClient).toBe(false);

    await open('job-exited');
    expect(shownTab()).toBe('Conversation');
    update(snap(sessions().map((each) => (each.sessionId === EXITED ? { ...each, alive: true, pid: 45_406 } : each))));
    await settle();
    expect(shownTab()).toBe('Conversation');
    expect(sockets.sockets).toHaveLength(1);
  });

  it('isn’t switched by Preferences either: a new choice is for the views that open after it', async () => {
    const { sockets, storage } = renderDashboard();
    await open('job-one');
    await waitFor(() => expect(sockets.sockets).toHaveLength(1));
    choosePreference('Open running background sessions on', 'Conversation');
    expect((storage as ReturnType<typeof memory>).values.get(BACKGROUND_TAB_KEY)).toBe('conversation');
    expect(viewName()).toBe('job-one');
    expect(shownTab()).toBe('Terminal');
    expect(sockets.last.closedByClient).toBe(false);
    await open('job-two');
    expect(shownTab()).toBe('Conversation');
    await settle();
    expect(sockets.sockets).toHaveLength(1);
  });

  it('is decided as a view is first shown: one that opens hidden, as in a root tab that isn’t open (W38), attaches only once it shows', async () => {
    const sockets = fakeSockets();
    const env: AttachEnv = { token: TOKEN, createSocket: sockets.factory, host: '127.0.0.1:4517' };
    const api = createApiClient({ apiKey: API_KEY, fetch: withoutSubagents(fakeServer()) });
    const running = job(9, 'job-unseen');
    const ui = (hidden: boolean) => (
      <ApiContext.Provider value={api}>
        <AttachContext.Provider value={env}>
          <SessionView session={running} listed onClose={() => {}} hidden={hidden} backgroundTab="terminal" />
        </AttachContext.Provider>
      </ApiContext.Provider>
    );
    const { rerender, container } = render(ui(true));
    await settle();
    expect(sockets.sockets).toHaveLength(0);
    rerender(ui(false));
    await settle();
    expect(within(container).getByRole('tab', { name: /^Terminal/ }).getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(sockets.sockets).toHaveLength(1));
  });
});

describe('focus as a view opens on its Terminal tab', () => {
  it('goes to the heading, then into the terminal as it attaches, as when you open the tab yourself; Escape there is the terminal’s, and F6 leaves it', async () => {
    const { sockets } = renderDashboard();
    await open('job-one');
    expect(document.activeElement).toBe(heading());
    await waitFor(() => expect(sockets.sockets).toHaveLength(1));
    await attachIt(sockets.last);
    expect(document.activeElement).toBe(terminals.at(-1)?.screen);

    press('Escape');
    expect(viewName()).toBe('job-one');
    press('F6');
    expect(document.activeElement).toBe(tab('Terminal'));
    expect(sockets.last.closedByClient).toBe(false);
    // Out of the terminal, Escape closes the view, as before.
    press('Escape');
    expect(view()).toBeUndefined();
  });

  it('stays where it went outside the view meanwhile, as in the filter, so what is typed there never reaches the session', async () => {
    const { sockets } = renderDashboard();
    await open('job-one');
    const filter = screen.getByRole('searchbox', { name: 'Filter sessions' });
    filter.focus();
    await waitFor(() => expect(sockets.sockets).toHaveLength(1));
    await attachIt(sockets.last);
    expect(attachStatus()).toBe('Attached');
    expect(document.activeElement).toBe(filter);
  });

  // Flipped by W57: before it, the terminal took focus here, so the next key after a reload went to the session.
  it('stays where it is as the terminal attaches from a ?session= on load, with nothing focused: the bar says how to type to it, and no key reaches the session', async () => {
    const { sockets } = renderDashboard(snap(), { search: `?view=all&session=${J1}` });
    await waitFor(() => expect(sockets.sockets).toHaveLength(1));
    expect(document.activeElement).toBe(document.body);
    await attachIt(sockets.last);
    expect(attachStatus()).toBe('Attached');
    expect(document.activeElement).toBe(document.body);
    expect(shownHint()).toBe(TYPE_HINT);
    // Enter would approve a dialog's highlighted option; `/`, a name and Enter would send a slash command.
    for (const key of ['Enter', '/', 'c', 'o', 'Enter']) press(key);
    expect(inputs(sockets.last)).toEqual([]);
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Filter sessions' }));
  });
});

describe('the terminal takes the keyboard only when you ask for it (W57)', () => {
  describe('never by itself', () => {
    it('after a reload, or in a tab the browser restores, which attach with the token the tab holds: Enter and j reach no session', async () => {
      window.sessionStorage.setItem(TOKEN_STORAGE_KEY, TOKEN);
      window.history.replaceState(null, '', `/?view=all&session=${J1}`);
      const fake = fakeSockets();
      render(<App createSocket={fake.factory} fetch={withoutSubagents(fakeServer())} />);
      const index = fake.last;
      act(() => {
        index.open();
        index.receive({ type: 'challenge', version: PROTOCOL_VERSION, nonce: NONCE });
      });
      await waitFor(() => expect(index.sent).toHaveLength(1));
      act(() => index.receive({ type: 'authenticated', apiKey: API_KEY }));
      act(() => index.receive({ type: 'snapshot', snapshot: snap() }));
      await settle();
      await waitFor(() => expect(fake.sockets).toHaveLength(2));
      const attach = fake.last;
      await attachIt(attach);
      expect(attachStatus()).toBe('Attached');
      expect(document.activeElement).toBe(document.body);
      expect(shownHint()).toBe(TYPE_HINT);
      press('Enter');
      // With nothing focused, j is the shortcut it always was: the next session, never a key for this one.
      press('j');
      await settle();
      expect(viewName()).toBe('job-two');
      expect(inputs(attach)).toEqual([]);
    });

    it('when back or forward returns to a running background session, even one a click opened moments before', async () => {
      const { sockets, history } = renderDashboard();
      await open('job-one');
      await waitFor(() => expect(sockets.sockets).toHaveLength(1));
      await attachIt(sockets.last);
      expect(terminalHasFocus()).toBe(true);
      await open('job-two');
      await waitFor(() => expect(sockets.sockets).toHaveLength(2));
      await attachIt(sockets.last);
      expect(terminalHasFocus()).toBe(true);

      history.back();
      await settle();
      expect(viewName()).toBe('job-one');
      await waitFor(() => expect(sockets.sockets).toHaveLength(3));
      await attachIt(sockets.last);
      expect(attachStatus()).toBe('Attached');
      expect(terminalHasFocus()).toBe(false);
      expect(shownHint()).toBe(TYPE_HINT);
      press('Enter');
      expect(inputs(sockets.last)).toEqual([]);

      history.forward();
      await settle();
      expect(viewName()).toBe('job-two');
      await waitFor(() => expect(sockets.sockets).toHaveLength(4));
      await attachIt(sockets.last);
      expect(terminalHasFocus()).toBe(false);
      expect(shownHint()).toBe(TYPE_HINT);
    });

    it('in the view of a session started from New session, which opens once it’s listed, even with its heading focused', async () => {
      const { sockets, update } = renderDashboard();
      // `n` with nothing focused, so focus has nowhere to go back to, and the view's heading takes it as the view opens.
      press('n');
      const dialog = screen.getByRole('dialog', { name: 'New session' });
      fireEvent.change(within(dialog).getByRole('textbox', { name: 'First prompt' }), { target: { value: 'A made-up first prompt.' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Start session' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New session' })).toBeNull());
      (document.activeElement as HTMLElement | null)?.blur();
      update(snap([...sessions(), job(57, STARTED.name, { shortId: STARTED.shortId })]));
      await settle();
      expect(viewName()).toBe(STARTED.name);
      expect(shownTab()).toBe('Terminal');
      expect(document.activeElement).toBe(heading());
      await waitFor(() => expect(sockets.sockets).toHaveLength(1));
      await attachIt(sockets.last);
      expect(terminalHasFocus()).toBe(false);
      expect(document.activeElement).toBe(heading());
      expect(shownHint()).toBe(TYPE_HINT);
    });

    it('in the view of a session started in a root tab you have since left, which switches back to it once it’s listed (W63)', async () => {
      const ROOTS = ['/Users/example/alpha', '/Users/example/bravo'];
      const twoRoots = (extra: SessionSummary[] = []) =>
        snapshot(
          ROOTS.map((root, index) => group({ key: `${root}/app`, label: 'app', root, sessions: [job(40 + index, `job-${index + 1}`, { cwd: `${root}/app` }), ...(index === 0 ? extra : [])] })),
          { roots: ROOTS },
        );
      const rootTab = (root: string) => screen.getAllByRole('tab').find((candidate) => candidate.classList.contains('root-tab') && candidate.querySelector('.root-tab-label')?.textContent === `~/${root.split('/').at(-1)}`)!;
      const { sockets, update } = renderDashboard(twoRoots(), { search: '' });
      await startSession();
      // The dialog has given focus back to New session by the time it has gone (W83).
      const newSession = screen.getByRole('button', { name: 'New session' });
      expect(document.activeElement).toBe(newSession);
      fireEvent.click(rootTab(ROOTS[1]!));
      await settle();
      update(twoRoots([job(58, STARTED.name, { shortId: STARTED.shortId, cwd: `${ROOTS[0]}/app` })]));
      await settle();

      expect(rootTab(ROOTS[0]!).getAttribute('aria-selected')).toBe('true');
      expect(viewName()).toBe(STARTED.name);
      expect(shownTab()).toBe('Terminal');
      await waitFor(() => expect(sockets.sockets).toHaveLength(1));
      await attachIt(sockets.last);
      expect(terminalHasFocus()).toBe(false);
      // Focus stays on New session, where the dialog gave it back, which the switch neither took away nor hid.
      expect(document.activeElement).toBe(newSession);
      expect(shownHint()).toBe(TYPE_HINT);
      press('Enter');
      expect(inputs(sockets.last)).toEqual([]);
    });

    it('when stepped onto with j, soon after a click opened the view before it: the click was that view’s', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      vi.setSystemTime(NOW);
      const { sockets } = renderDashboard();
      await open('demo-a');
      press('j');
      await settle();
      expect(viewName()).toBe('job-one');
      await pass(ATTACH_DELAY_MS);
      await attachQuietly(sockets.last);
      expect(attachStatus()).toBe('Attached');
      expect(terminalHasFocus()).toBe(false);
      expect(document.activeElement).toBe(heading());
      expect(shownHint()).toBe(TYPE_HINT);
    });
  });

  describe('when you ask for it in this page', () => {
    it('after a click or Enter on its row, as it attaches, and the next key reaches the session; the bar shows F6’s hint', async () => {
      const { sockets } = renderDashboard();
      await open('job-one');
      await waitFor(() => expect(sockets.sockets).toHaveLength(1));
      // Attaching, the bar shows F6's hint, so one that's about to take focus doesn't flash the other.
      expect(shownHint()).toBe('F6F6 to leave the terminal');
      await attachIt(sockets.last);
      expect(terminalHasFocus()).toBe(true);
      expect(shownHint()).toBe('F6F6 to leave the terminal');
      press('Enter');
      expect(inputs(sockets.last)).toEqual(['\r']);
    });

    it('and keeps it, attached, when a session started from New session is listed while you type in it (W63)', async () => {
      const { sockets, update } = renderDashboard();
      await startSession();
      await open('job-one');
      await waitFor(() => expect(sockets.sockets).toHaveLength(1));
      await attachIt(sockets.last);
      expect(terminalHasFocus()).toBe(true);

      update(snap([...sessions(), job(57, STARTED.name, { shortId: STARTED.shortId })]));
      await settle();
      expect(viewName()).toBe('job-one');
      expect(terminalHasFocus()).toBe(true);
      expect(sockets.sockets).toHaveLength(1);
      expect(sockets.last.closedByClient).toBe(false);
      expect(toastMessages()).toEqual([listedText(STARTED.name)]);
      press('y');
      expect(inputs(sockets.last)).toEqual(['y']);
    });

    it('after a click on its Terminal tab, in a view the URL opened without focus', async () => {
      const { sockets } = renderDashboard(snap(), { search: `?view=all&session=${J1}` });
      await waitFor(() => expect(sockets.sockets).toHaveLength(1));
      await attachIt(sockets.last);
      expect(terminalHasFocus()).toBe(false);
      fireEvent.click(tab('Conversation'));
      fireEvent.click(tab('Terminal'));
      // The tab takes focus itself, as Safari gives a clicked button none.
      expect(document.activeElement).toBe(tab('Terminal'));
      await waitFor(() => expect(sockets.sockets).toHaveLength(2));
      await attachIt(sockets.last);
      expect(terminalHasFocus()).toBe(true);
    });

    it('after Attach again, in a view a reload opened, though the button has gone by the time it attaches', async () => {
      const { sockets } = renderDashboard(snap(), { search: `?view=all&session=${J1}` });
      await waitFor(() => expect(sockets.sockets).toHaveLength(1));
      await attachIt(sockets.last);
      act(() => sockets.last.receive({ type: 'exit', code: 0 }));
      expect(attachStatus()).toBe('Detached');
      fireEvent.click(within(view()!).getByRole('button', { name: 'Attach again' }));
      await waitFor(() => expect(sockets.sockets).toHaveLength(2));
      expect(within(view()!).queryByRole('button', { name: 'Attach again' })).toBeNull();
      await attachIt(sockets.last);
      expect(terminalHasFocus()).toBe(true);
    });

    it('after Restart and attach, for one the URL opened that had finished, once the confirmation had taken focus to Cancel', async () => {
      const { sockets } = renderDashboard(snap(), { search: `?view=all&session=${J1}` });
      await waitFor(() => expect(sockets.sockets).toHaveLength(1));
      const socket = sockets.last;
      act(() => {
        socket.open();
        socket.receive({ type: 'challenge', version: PROTOCOL_VERSION, nonce: NONCE });
      });
      await waitFor(() => expect(socket.sent).toHaveLength(1));
      act(() => socket.receive({ type: 'ready' }));
      act(() => socket.receive({ type: 'needs-restart' }));
      const confirm = within(view()!).getByRole('alertdialog');
      expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: 'Cancel' }));
      fireEvent.click(within(confirm).getByRole('button', { name: 'Restart and attach' }));
      act(() => socket.receive({ type: 'attached' }));
      expect(terminalHasFocus()).toBe(true);
    });
  });

  describe('the gesture', () => {
    it(`runs out: an attach that completes more than ${GESTURE_MS / 1000} s after the click takes no focus`, async () => {
      const { sockets } = renderDashboard();
      await open('job-one');
      await waitFor(() => expect(sockets.sockets).toHaveLength(1));
      vi.setSystemTime(NOW + GESTURE_MS + 1);
      await attachIt(sockets.last);
      expect(attachStatus()).toBe('Attached');
      expect(terminalHasFocus()).toBe(false);
      expect(document.activeElement).toBe(heading());
      expect(shownHint()).toBe(TYPE_HINT);
    });

    it(`still holds at ${GESTURE_MS / 1000} s`, async () => {
      const { sockets } = renderDashboard();
      await open('job-one');
      await waitFor(() => expect(sockets.sockets).toHaveLength(1));
      vi.setSystemTime(NOW + GESTURE_MS);
      await attachIt(sockets.last);
      expect(terminalHasFocus()).toBe(true);
    });

    it('is used once: the attach it was for spends it, and a view opened again after takes none', async () => {
      const { sockets, history } = renderDashboard();
      await open('job-one');
      await waitFor(() => expect(sockets.sockets).toHaveLength(1));
      await attachIt(sockets.last);
      expect(terminalHasFocus()).toBe(true);
      // Away and back in the history, with no click on the row between: its click is spent.
      await open('demo-a');
      history.back();
      await settle();
      expect(viewName()).toBe('job-one');
      await waitFor(() => expect(sockets.sockets).toHaveLength(2));
      await attachIt(sockets.last);
      expect(terminalHasFocus()).toBe(false);
    });

    it('holds the guard: what’s typed in the filter after a click on a row stays in the filter, before and after the attach', async () => {
      const { sockets } = renderDashboard();
      await open('job-one');
      press('/');
      const filter = screen.getByRole('searchbox', { name: 'Filter sessions' });
      expect(document.activeElement).toBe(filter);
      for (const key of ['j', 'o', 'b']) press(key);
      fireEvent.change(filter, { target: { value: 'job' } });
      await waitFor(() => expect(sockets.sockets).toHaveLength(1));
      await attachIt(sockets.last);
      expect(document.activeElement).toBe(filter);
      for (const key of ['-', 'o', 'Enter']) press(key);
      expect(inputs(sockets.last)).toEqual([]);
      expect((filter as HTMLInputElement).value).toBe('job');
      expect(shownHint()).toBe(TYPE_HINT);
    });
  });

  describe('the hint', () => {
    it('says how to type to it while it’s attached without focus: in the bar, in the place F6’s hint keeps, read in place, and describing the Terminal tab, with no live region', async () => {
      const { sockets } = renderDashboard(snap(), { search: `?view=all&session=${J1}` });
      await waitFor(() => expect(sockets.sockets).toHaveLength(1));
      const regions = () => document.querySelectorAll('[role="status"], [role="alert"], [aria-live]').length;
      const before = regions();
      await attachIt(sockets.last);
      const hints = view()!.querySelector('.attach-bar .attach-hints')!;
      const [leave, type] = [...hints.querySelectorAll<HTMLElement>('.attach-hint')];
      expect(type?.textContent).toBe('Click the terminal, or Tab to it, to type to the session');
      expect([leave?.dataset.shown, type?.dataset.shown]).toEqual(['false', 'true']);
      // Plain text: no role, no live region, none inside the badge's status region, and none added.
      expect(type?.getAttribute('role')).toBeNull();
      expect(type?.closest('[aria-live], [role="status"], [role="alert"]')).toBeNull();
      expect(regions()).toBe(before);
      expect(tab('Terminal').getAttribute('aria-describedby')).toBe(type?.id);
      expect(document.getElementById(type!.id)).toBe(type);
    });

    it('gives way to F6’s once the terminal has focus, from a click on it or Tab, and comes back after F6', async () => {
      const { sockets } = renderDashboard(snap(), { search: `?view=all&session=${J1}` });
      await waitFor(() => expect(sockets.sockets).toHaveLength(1));
      await attachIt(sockets.last);
      expect(shownHint()).toBe(TYPE_HINT);
      act(() => terminals.at(-1)!.screen.focus());
      expect(shownHint()).toBe('F6F6 to leave the terminal');
      press('Enter');
      expect(inputs(sockets.last)).toEqual(['\r']);
      press('F6');
      expect(document.activeElement).toBe(tab('Terminal'));
      expect(shownHint()).toBe(TYPE_HINT);
    });

    it('gives way to F6’s while it attaches and once the attach has ended, and goes with the terminal', async () => {
      const { sockets } = renderDashboard(snap(), { search: `?view=all&session=${J1}` });
      await waitFor(() => expect(sockets.sockets).toHaveLength(1));
      expect(attachStatus()).toBe('Attaching…');
      expect(shownHint()).toBe('F6F6 to leave the terminal');
      expect(tab('Terminal').hasAttribute('aria-describedby')).toBe(false);
      await attachIt(sockets.last);
      act(() => sockets.last.receive({ type: 'exit', code: 0 }));
      expect(shownHint()).toBe('F6F6 to leave the terminal');
      expect(tab('Terminal').hasAttribute('aria-describedby')).toBe(false);
      fireEvent.click(within(view()!).getByRole('button', { name: 'Back to the conversation' }));
      expect(view()!.querySelector('.attach-hints')).toBeNull();
    });
  });

  describe('the setting, pitwall.terminal-focus.v1 (terminalFocus.ts)', () => {
    it('on never, takes no focus after a click on the row, the Terminal tab or Attach again, and the hint says how to type to it', async () => {
      const { sockets } = renderDashboard(snap(), { storage: memory({ [TERMINAL_FOCUS_KEY]: 'never' }) });
      await open('job-one');
      await waitFor(() => expect(sockets.sockets).toHaveLength(1));
      await attachIt(sockets.last);
      expect(attachStatus()).toBe('Attached');
      expect(terminalHasFocus()).toBe(false);
      expect(document.activeElement).toBe(heading());
      expect(shownHint()).toBe(TYPE_HINT);
      press('Enter');
      expect(inputs(sockets.last)).toEqual([]);

      fireEvent.click(tab('Conversation'));
      fireEvent.click(tab('Terminal'));
      await waitFor(() => expect(sockets.sockets).toHaveLength(2));
      await attachIt(sockets.last);
      expect(terminalHasFocus()).toBe(false);
      expect(document.activeElement).toBe(tab('Terminal'));

      act(() => sockets.last.receive({ type: 'exit', code: 0 }));
      fireEvent.click(within(view()!).getByRole('button', { name: 'Attach again' }));
      await waitFor(() => expect(sockets.sockets).toHaveLength(3));
      await attachIt(sockets.last);
      expect(terminalHasFocus()).toBe(false);
      expect(shownHint()).toBe(TYPE_HINT);
      // Clicking or Tabbing to it still reaches it.
      act(() => terminals.at(-1)!.screen.focus());
      press('y');
      expect(inputs(sockets.last)).toEqual(['y']);
    });

    it('on after-open, stored or by default, takes focus after a click on the row, and still none after a reload', async () => {
      for (const storage of [memory({ [TERMINAL_FOCUS_KEY]: 'after-open' }), memory()]) {
        const clicked = renderDashboard(snap(), { storage });
        await open('job-one');
        await waitFor(() => expect(clicked.sockets.sockets).toHaveLength(1));
        await attachIt(clicked.sockets.last);
        expect(terminalHasFocus()).toBe(true);
        clicked.unmount();

        const loaded = renderDashboard(snap(), { storage, search: `?view=all&session=${J1}` });
        await waitFor(() => expect(loaded.sockets.sockets).toHaveLength(1));
        await attachIt(loaded.sockets.last);
        expect(terminalHasFocus()).toBe(false);
        loaded.unmount();
      }
    });

    it('is after-open for a value it doesn’t know, "always" included, and for storage that throws', async () => {
      const throwing = (() => ({
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
      })) as StorageSource;
      for (const storage of [memory({ [TERMINAL_FOCUS_KEY]: 'always' }), memory({ [TERMINAL_FOCUS_KEY]: 'sideways' }), throwing]) {
        const loaded = renderDashboard(snap(), { storage, search: `?view=all&session=${J1}` });
        await waitFor(() => expect(loaded.sockets.sockets).toHaveLength(1));
        await attachIt(loaded.sockets.last);
        expect(terminalHasFocus()).toBe(false);
        loaded.unmount();

        const clicked = renderDashboard(snap(), { storage });
        await open('job-one');
        await waitFor(() => expect(clicked.sockets.sockets).toHaveLength(1));
        await attachIt(clicked.sockets.last);
        expect(terminalHasFocus()).toBe(true);
        clicked.unmount();
      }
    });
  });
});

describe('stepping with j, k, ↑ and ↓', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(NOW);
  });

  it('j past three running background sessions attaches none of them; k back onto one attaches it once it has stayed open for the delay', async () => {
    const { sockets } = renderDashboard();
    await open('demo-a');
    for (const name of ['job-one', 'job-two', 'job-three', 'demo-c']) {
      press('j');
      await settle();
      expect(viewName()).toBe(name);
      if (name !== 'demo-c') {
        // On its Terminal tab, saying it's about to attach, with focus on the new heading.
        expect(shownTab()).toBe('Terminal');
        expect(attachStatus()).toBe('Attaching…');
        expect(document.activeElement).toBe(heading());
      }
      await pass(ATTACH_DELAY_MS / 2);
    }
    await pass(ATTACH_DELAY_MS * 4);
    expect(sockets.sockets).toHaveLength(0);

    press('k');
    await settle();
    expect(viewName()).toBe('job-three');
    await pass(ATTACH_DELAY_MS - 1);
    expect(sockets.sockets).toHaveLength(0);
    await pass(1);
    expect(sockets.sockets).toHaveLength(1);
    await attachQuietly(sockets.last);
    expect(sent(sockets.last)[1]).toEqual({ type: 'open', sessionId: J3, cols: 80, rows: 24 });
    expect(attachStatus()).toBe('Attached');
    // The terminal takes no focus, so the next key is still a step, not a keystroke for the session.
    expect(document.activeElement).toBe(heading());
    press('j');
    await settle();
    expect(viewName()).toBe('demo-c');
    expect(sockets.last.closedByClient).toBe(true);
  });

  it('cancels the wait when it moves on, the wait counting from when each view opened', async () => {
    const { sockets } = renderDashboard();
    await open('demo-a');
    press('j');
    await settle();
    await pass(ATTACH_DELAY_MS - 100);
    press('j');
    await settle();
    expect(viewName()).toBe('job-two');
    await pass(ATTACH_DELAY_MS - 100);
    expect(sockets.sockets).toHaveLength(0);
    await pass(100);
    expect(sockets.sockets).toHaveLength(1);
    await attachQuietly(sockets.last);
    expect(sent(sockets.last)[1]).toMatchObject({ type: 'open', sessionId: J2 });
  });

  it('from a row, leaves focus on the rows, there too once the session it rests on attaches, with ↓ and ↑ as with j and k', async () => {
    const { sockets } = renderDashboard();
    await open('demo-a');
    rowButton('demo-a').focus();
    press('j');
    await settle();
    expect(viewName()).toBe('job-one');
    expect(document.activeElement).toBe(rowButton('job-one'));
    await pass(ATTACH_DELAY_MS);
    expect(sockets.sockets).toHaveLength(1);
    await attachQuietly(sockets.last);
    expect(document.activeElement).toBe(rowButton('job-one'));

    press('ArrowDown');
    await settle();
    expect(viewName()).toBe('job-two');
    expect(document.activeElement).toBe(rowButton('job-two'));
    expect(sockets.sockets[0]?.closedByClient).toBe(true);
    press('ArrowDown');
    await settle();
    expect(viewName()).toBe('job-three');
    await pass(ATTACH_DELAY_MS - 1);
    expect(sockets.sockets).toHaveLength(1);
    await pass(1);
    expect(sockets.sockets).toHaveLength(2);
    await attachQuietly(sockets.last);
    expect(document.activeElement).toBe(rowButton('job-three'));
  });

  it('from the view’s header with ↓, waits the same way, and the terminal leaves focus on the heading', async () => {
    const { sockets } = renderDashboard();
    await open('demo-a');
    press('ArrowDown', heading());
    await settle();
    expect(viewName()).toBe('job-one');
    expect(document.activeElement).toBe(heading());
    await pass(ATTACH_DELAY_MS - 1);
    expect(sockets.sockets).toHaveLength(0);
    await pass(1);
    await attachQuietly(sockets.last);
    expect(document.activeElement).toBe(heading());
    press('ArrowDown', heading());
    await settle();
    expect(viewName()).toBe('job-two');
  });

  it('attaches nothing when Conversation is chosen during the wait; Terminal, opened again, attaches at once and takes focus', async () => {
    const { sockets } = renderDashboard();
    await open('demo-a');
    press('j');
    await settle();
    fireEvent.click(tab('Conversation'));
    await pass(ATTACH_DELAY_MS * 2);
    expect(sockets.sockets).toHaveLength(0);
    fireEvent.click(tab('Terminal'));
    await until(() => sockets.sockets.length === 1, 'the attach socket');
    await attachQuietly(sockets.last);
    expect(document.activeElement).toBe(terminals.at(-1)?.screen);
  });

  it('isn’t a step: a click on a row after stepping attaches at once', async () => {
    const { sockets } = renderDashboard();
    await open('demo-a');
    press('j');
    await settle();
    expect(viewName()).toBe('job-one');
    await open('job-two');
    await until(() => sockets.sockets.length === 1, 'the attach socket');
    await attachQuietly(sockets.last);
    expect(sent(sockets.last)[1]).toMatchObject({ type: 'open', sessionId: J2 });
  });
});

describe('the four-attach limit (D9)', () => {
  const ROOTS = ['alpha', 'bravo', 'charlie', 'delta', 'echo'].map((name) => `/Users/example/${name}`);
  /** A running background session in each of five roots, so five views can be open at once, one in each root tab (W38). */
  const fiveRoots = () =>
    snapshot(
      ROOTS.map((root, index) => group({ key: `${root}/app`, label: 'app', root, sessions: [job(20 + index, `job-${index + 1}`, { cwd: `${root}/app` })] })),
      { roots: ROOTS },
    );
  const switchTo = (root: string) => {
    const found = screen.getAllByRole('tab').find((candidate) => candidate.classList.contains('root-tab') && candidate.querySelector('.root-tab-label')?.textContent === `~/${root.split('/').at(-1)}`);
    if (!found) throw new Error(`no root tab for ${root}`);
    fireEvent.click(found);
  };

  /**
   * The attach server, as src/server/attach.ts plays it: MAX_ATTACHED sockets past the handshake at
   * most, server-wide, until they close; past that, the next is closed with WS_CLOSE_TOO_MANY.
   */
  async function serve(socket: FakeSocket, admitted: Set<FakeSocket>) {
    act(() => {
      socket.open();
      socket.receive({ type: 'challenge', version: PROTOCOL_VERSION, nonce: NONCE });
    });
    await waitFor(() => expect(socket.sent.some((data) => data.includes('"auth"'))).toBe(true));
    for (const each of [...admitted]) if (each.closedByClient) admitted.delete(each);
    if (admitted.size >= MAX_ATTACHED) {
      act(() => socket.serverClose(WS_CLOSE_TOO_MANY));
      return;
    }
    admitted.add(socket);
    act(() => socket.receive({ type: 'ready' }));
    act(() => socket.receive({ type: 'attached' }));
  }

  it('a fifth running background session, opened on its Terminal tab, says so as before, with Attach again; the four stay attached, and once one detaches, Attach again attaches', async () => {
    const { sockets } = renderDashboard(fiveRoots(), { search: '' });
    const admitted = new Set<FakeSocket>();
    for (const [index, root] of ROOTS.entries()) {
      if (index > 0) switchTo(root);
      await settle();
      await open(`job-${index + 1}`);
      expect(shownTab()).toBe('Terminal');
      await waitFor(() => expect(sockets.sockets).toHaveLength(index + 1));
      await serve(sockets.last, admitted);
    }
    expect(admitted.size).toBe(MAX_ATTACHED);

    // The fifth: the terminal's danger alert, its Detached badge, Attach again and Back to the
    // conversation, and the Terminal tab still open.
    expect(viewName()).toBe('job-5');
    const alert = within(view()!).getByRole('alert');
    expect(alert.textContent).toBe('4 sessions are already attached; detach one first.');
    expect(attachStatus()).toBe('Detached');
    expect(shownTab()).toBe('Terminal');
    expect(within(view()!).getByRole('button', { name: 'Attach again' })).toBeTruthy();
    expect(within(view()!).getByRole('button', { name: 'Back to the conversation' })).toBeTruthy();
    // The other four, each in its own root tab's view, kept hidden, are still attached.
    expect(sockets.sockets.slice(0, 4).map((socket) => socket.closedByClient)).toEqual([false, false, false, false]);

    switchTo(ROOTS[0]!);
    await settle();
    fireEvent.click(within(view()!).getByRole('button', { name: 'Detach' }));
    expect(sockets.sockets[0]?.closedByClient).toBe(true);
    switchTo(ROOTS[4]!);
    await settle();
    fireEvent.click(within(view()!).getByRole('button', { name: 'Attach again' }));
    await waitFor(() => expect(sockets.sockets).toHaveLength(6));
    await serve(sockets.last, admitted);
    expect(attachStatus()).toBe('Attached');
    expect(within(view()!).queryByRole('alert')).toBeNull();
  });

  it('takes one place at most in a root tab: opening the next session detaches the last', async () => {
    const { sockets } = renderDashboard();
    await open('job-one');
    await waitFor(() => expect(sockets.sockets).toHaveLength(1));
    await attachIt(sockets.last);
    await open('job-two');
    expect(sockets.sockets[0]?.closedByClient).toBe(true);
    await waitFor(() => expect(sockets.sockets).toHaveLength(2));
    expect(sockets.sockets.filter((socket) => !socket.closedByClient)).toHaveLength(1);
  });
});

describe('Preferences: Open running background sessions on', () => {
  const SETTING = 'Open running background sessions on';
  const labelOf = (radio: HTMLInputElement) => radio.labels?.[0]?.textContent;
  const describedBy = (element: Element) => document.getElementById(element.getAttribute('aria-describedby') ?? '')?.textContent;
  const checked = () => preferenceOptions(SETTING).map((radio) => radio.checked);

  it("is the Session view section's first radio group: Terminal, chosen by default, and Conversation, each with a line saying what it does", () => {
    renderDashboard();
    const dialog = openPreferences();
    const section = within(dialog).getByRole('region', { name: 'Session view' });
    expect(within(section).getAllByRole('group')[0]).toBe(preferenceGroup(SETTING));
    expect(preferenceOptions(SETTING).map(labelOf)).toEqual(['Terminal', 'Conversation']);
    expect(preferenceOptions(SETTING).map(describedBy)).toEqual([
      'The session attaches as its view opens, so its terminal is ready to use.',
      'The session attaches only once you open its Terminal tab.',
    ]);
    expect(checked()).toEqual([true, false]);
    // Opening focuses the choice of Group sessions by, the dialog's first group.
    expect(document.activeElement).toBe(preferenceOption('Group sessions by', 'Main repo'));
  });

  it('applies a choice at once, with the dialog still open, stores it alone, and Escape then gives focus back to the button', () => {
    const { storage } = renderDashboard();
    choosePreference(SETTING, 'Conversation', { close: false });
    expect(preferencesDialog()).not.toBeNull();
    expect(document.activeElement).toBe(preferenceOption(SETTING, 'Conversation'));
    expect([...(storage as ReturnType<typeof memory>).values]).toEqual([[BACKGROUND_TAB_KEY, 'conversation']]);
    press('Escape');
    expect(preferencesDialog()).toBeNull();
    expect(document.activeElement).toBe(preferencesButton());
    openPreferences();
    expect(checked()).toEqual([false, true]);
  });

  it('keeps the choice across a reload, under pitwall.background-tab.v1', async () => {
    const storage = memory();
    const first = renderDashboard(snap(), { storage });
    choosePreference(SETTING, 'Conversation');
    first.unmount();
    const { sockets } = renderDashboard(snap(), { storage, search: `?view=all&session=${J1}` });
    await settle();
    expect(shownTab()).toBe('Conversation');
    expect(sockets.sockets).toHaveLength(0);
    expect(storage.values.get(BACKGROUND_TAB_KEY)).toBe('conversation');
  });

  it('is Terminal when nothing is stored, the value is bad, or storage throws, and a choice still works for the page', async () => {
    const throwing = (() => ({
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    })) as StorageSource;
    for (const storage of [
      memory(),
      memory({ [BACKGROUND_TAB_KEY]: 'sideways' }),
      memory({ [BACKGROUND_TAB_KEY]: 'Terminal' }),
      (() => {
        throw new Error('blocked');
      }) as StorageSource,
      throwing,
    ]) {
      const { sockets, unmount } = renderDashboard(snap(), { storage });
      await open('job-one');
      expect(shownTab()).toBe('Terminal');
      await waitFor(() => expect(sockets.sockets).toHaveLength(1));
      choosePreference(SETTING, 'Conversation');
      await open('job-two');
      expect(shownTab()).toBe('Conversation');
      unmount();
    }
    expect(readBackgroundTab(throwing)).toBe('terminal');
    expect(() => writeBackgroundTab('conversation', throwing)).not.toThrow();
  });

  it('leaves the page working when the browser’s own localStorage throws, as with site data blocked', async () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
    try {
      expect(readBackgroundTab()).toBe('terminal');
      expect(() => writeBackgroundTab('conversation')).not.toThrow();
      // The whole page, on the browser's storage: the view opens on Terminal, and a choice still works for the page.
      const { sockets } = renderDashboard(snap(), { storage: browserStorage });
      await open('job-one');
      expect(shownTab()).toBe('Terminal');
      await waitFor(() => expect(sockets.sockets).toHaveLength(1));
      choosePreference(SETTING, 'Conversation');
      await open('job-two');
      expect(shownTab()).toBe('Conversation');
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });
});

describe('Preferences: The terminal takes the keyboard (W57, W59)', () => {
  const SETTING = 'The terminal takes the keyboard';
  const labelOf = (radio: HTMLInputElement) => radio.labels?.[0]?.textContent;

  it("is the Session view section's second radio group: When you open it, chosen by default, then Never", () => {
    renderDashboard();
    const section = within(openPreferences()).getByRole('region', { name: 'Session view' });
    expect(within(section).getAllByRole('group')[1]).toBe(preferenceGroup(SETTING));
    expect(preferenceOptions(SETTING).map(labelOf)).toEqual(['When you open it', 'Never']);
    expect(preferenceOptions(SETTING).map((radio) => radio.checked)).toEqual([true, false]);
  });

  it('is the setting the views read as they attach: Never, chosen there, keeps the keyboard out of the terminal after a click on a row, and When you open it gives it back', async () => {
    const { sockets, storage } = renderDashboard();
    choosePreference(SETTING, 'Never');
    expect((storage as ReturnType<typeof memory>).values.get(TERMINAL_FOCUS_KEY)).toBe('never');
    await open('job-one');
    await waitFor(() => expect(sockets.sockets).toHaveLength(1));
    await attachIt(sockets.last);
    expect(terminalHasFocus()).toBe(false);
    expect(document.activeElement).toBe(heading());

    choosePreference(SETTING, 'When you open it');
    expect((storage as ReturnType<typeof memory>).values.get(TERMINAL_FOCUS_KEY)).toBe('after-open');
    await open('job-two');
    await waitFor(() => expect(sockets.sockets).toHaveLength(2));
    await attachIt(sockets.last);
    expect(terminalHasFocus()).toBe(true);
  });
});
