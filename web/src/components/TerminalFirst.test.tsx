// Running background sessions open on the Terminal tab (W54): which tab a view opens on, for each kind
// and state, from a click, ?session=, the back button and a reload, and with View preferences on
// Conversation; a tab you chose staying chosen; where focus goes as the terminal attaches; stepping with
// j, k, ↑ and ↓, which waits before attaching, so passing through attaches nothing; the four-attach
// limit (D9); and the setting's menu and its storage. Made-up sessions only, and fake sockets: nothing
// here reaches a session.

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
import { computeProof } from '../proof.js';
import { fakeSockets, group, minutesAgo, NOW, session, snapshot, type FakeSocket } from '../test/fixtures.js';
import { fakeHistory } from '../test/history.js';
import { ATTACH_DELAY_MS } from '../timing.js';
import { TOKEN_STORAGE_KEY } from '../token.js';
import { Dashboard } from './Dashboard.js';
import { SessionView } from './SessionView.js';
import type { TerminalHandle } from './Terminal.js';

// xterm.js, replaced by a terminal whose screen is a textarea, so where focus goes can be seen.
class FakeTerminal implements TerminalHandle {
  cols = 80;
  rows = 24;
  disposed = false;
  readonly screen: HTMLTextAreaElement;
  constructor(container: HTMLElement) {
    this.screen = document.createElement('textarea');
    this.screen.className = 'fake-terminal';
    container.append(this.screen);
  }
  write() {}
  onData() {}
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

/** Every GET is a conversation page of one entry; every POST is refused, and recorded. */
function fakeServer() {
  return vi.fn<FetchLike>(async (url, init) => {
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
  const api = createApiClient({ apiKey: API_KEY, fetch });
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
/** Lets real I/O finish, such as WebCrypto's proof, while fake timers stand still. */
const io = () => act(() => new Promise<void>((resolve) => setImmediate(resolve)));
/** Waits for `done` without timers, for the tests that fake them. */
async function until(done: () => boolean) {
  for (let i = 0; i < 200 && !done(); i += 1) await io();
  expect(done()).toBe(true);
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
  await until(() => socket.sent.length === 1);
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
    render(<App createSocket={fake.factory} fetch={fetch} />);
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

  it('is Conversation with View preferences on Conversation, from a click, a ?session= and the back button, and nothing attaches', async () => {
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

  it('isn’t switched by View preferences either: a new choice is for the views that open after it', async () => {
    const { sockets, storage } = renderDashboard();
    await open('job-one');
    await waitFor(() => expect(sockets.sockets).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'View preferences' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Open running background sessions on' })).getByRole('menuitemradio', { name: 'Conversation' }));
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
    const api = createApiClient({ apiKey: API_KEY, fetch: fakeServer() });
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

  it('goes into the terminal as it attaches from a ?session= on load, with nothing focused', async () => {
    const { sockets } = renderDashboard(snap(), { search: `?view=all&session=${J1}` });
    await waitFor(() => expect(sockets.sockets).toHaveLength(1));
    expect(document.activeElement).toBe(document.body);
    await attachIt(sockets.last);
    expect(document.activeElement).toBe(terminals.at(-1)?.screen);
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
    await until(() => sockets.sockets.length === 1);
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
    await until(() => sockets.sockets.length === 1);
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

describe('View preferences: Open running background sessions on', () => {
  const prefsButton = () => screen.getByRole('button', { name: 'View preferences' });
  const group = () => screen.getByRole('group', { name: 'Open running background sessions on' });
  const optionsOf = () => within(group()).getAllByRole('menuitemradio');
  const optionName = (option: Element) => document.getElementById(option.getAttribute('aria-labelledby') ?? '')?.textContent;
  const describedBy = (option: Element) => document.getElementById(option.getAttribute('aria-describedby') ?? '')?.textContent;

  it('is a second radio group, after a separator: Terminal, chosen by default, and Conversation, each with a line saying what it does', () => {
    renderDashboard();
    fireEvent.click(prefsButton());
    const menu = screen.getByRole('menu', { name: 'View preferences' });
    const groups = within(menu).getAllByRole('group');
    expect(groups.map((each) => each.getAttribute('aria-label'))).toEqual(['Group sessions by', 'Open running background sessions on']);
    expect(group().previousElementSibling?.getAttribute('role')).toBe('separator');
    expect(optionsOf().map(optionName)).toEqual(['Terminal', 'Conversation']);
    expect(optionsOf().map(describedBy)).toEqual([
      'The session attaches as its view opens, so you can type to it.',
      'The session attaches only once you open its Terminal tab.',
    ]);
    expect(optionsOf().map((option) => option.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    // Opening focuses the chosen grouping, the menu's first group.
    expect(optionName(document.activeElement as Element)).toBe('Main repo');
  });

  it('chooses with the keyboard: End, then Enter, closes the menu with focus back on its button, and stores the choice alone', () => {
    const { storage } = renderDashboard();
    const button = prefsButton();
    button.focus();
    fireEvent.click(button);
    press('End');
    expect(optionName(document.activeElement as Element)).toBe('Conversation');
    // Enter on a menu item's button is a click.
    fireEvent.click(document.activeElement as Element);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
    expect([...(storage as ReturnType<typeof memory>).values]).toEqual([[BACKGROUND_TAB_KEY, 'conversation']]);
    fireEvent.click(button);
    expect(optionsOf().map((option) => option.getAttribute('aria-checked'))).toEqual(['false', 'true']);
  });

  it('keeps the choice across a reload, under pitwall.background-tab.v1', async () => {
    const storage = memory();
    const first = renderDashboard(snap(), { storage });
    fireEvent.click(prefsButton());
    fireEvent.click(optionsOf()[1]!);
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
      fireEvent.click(prefsButton());
      fireEvent.click(optionsOf()[1]!);
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
      fireEvent.click(prefsButton());
      fireEvent.click(optionsOf()[1]!);
      await open('job-two');
      expect(shownTab()).toBe('Conversation');
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });
});
