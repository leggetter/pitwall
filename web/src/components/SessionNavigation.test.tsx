// Getting to and around the session view (W22): ?session= in the URL and history, focus on open and
// close, ↑ and ↓ in the rows and the view's header, Escape's layers, the tabs' ARIA, the divider, and
// the view kept whole when the window crosses 1,200 px. Made-up sessions only.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type ConversationPage, type IndexSnapshot, type SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import { App } from '../App.js';
import { AttachContext, type AttachEnv } from '../attach.js';
import type { ConnectionView } from '../connection.js';
import type { StorageSource } from '../groupState.js';
import { PANEL_WIDTH_KEY, readPanelWidth } from '../panelWidth.js';
import type { NavigationEnv } from '../selection.js';
import { fakeSockets, group, minutesAgo, NOW, session, snapshot } from '../test/fixtures.js';
import { fakeHistory } from '../test/history.js';
import { TOKEN_STORAGE_KEY } from '../token.js';
import { Dashboard } from './Dashboard.js';
import type { TerminalHandle } from './Terminal.js';

// xterm.js, replaced by a terminal that does nothing, through the module the view loads it from.
class QuietTerminal implements TerminalHandle {
  cols = 80;
  rows = 24;
  disposed = false;
  write() {}
  onData() {}
  fit() {}
  focus() {}
  dispose() {
    this.disposed = true;
  }
}
const terminals: QuietTerminal[] = [];
vi.mock('../xterm.js', () => ({
  createXterm: () => {
    const terminal = new QuietTerminal();
    terminals.push(terminal);
    return terminal;
  },
}));

const API_KEY = 'k'.repeat(43);
const TOKEN = 'pitwall-test-token-0123456789abcdefghijklmnop';
const id = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const A = id(1);
const B = id(2);
const C = id(3);
const DONE = id(4);

/** Three sessions in the order shown, A, B and C, and a finished one in the collapsed Finished section. */
function sessions(): SessionSummary[] {
  return [
    session({ sessionId: A, name: 'demo-a', title: 'Fix the export', lastActivityAt: minutesAgo(1) }),
    session({ sessionId: B, name: 'demo-b', kind: 'background', shortId: 'pt0002', state: 'working', status: undefined, lastActivityAt: minutesAgo(2) }),
    session({ sessionId: C, name: 'demo-c', lastActivityAt: minutesAgo(3) }),
    session({ sessionId: DONE, name: 'demo-done', kind: 'background', shortId: 'pt0004', state: 'done', alive: false, pid: undefined, finished: true, status: undefined }),
  ];
}
const snap = (list: SessionSummary[] = sessions()): IndexSnapshot => snapshot([group({ sessions: list })]);

/** Every GET is a conversation page of one entry; every POST is refused, and recorded. */
function fakeServer() {
  return vi.fn<FetchLike>(async (url, init) => {
    if (init.method === 'POST') return new Response(JSON.stringify({ ok: false, error: 'not in this test' }), { status: 409 });
    const sessionId = decodeURIComponent(url.split('/')[3] ?? '');
    const page: ConversationPage = { sessionId, entries: [{ kind: 'assistant', text: `reply from ${sessionId.slice(-2)}` }] };
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
  navigation?: NavigationEnv;
  storage?: StorageSource;
}

function renderDashboard(first: IndexSnapshot = snap(), options: Options = {}) {
  const history = fakeHistory(options.search ?? '?view=all');
  const navigation = options.navigation ?? history.navigation;
  const fetch = fakeServer();
  const api = createApiClient({ apiKey: API_KEY, fetch });
  const sockets = fakeSockets();
  const attach: AttachEnv = { token: TOKEN, createSocket: sockets.factory, host: '127.0.0.1:4517' };
  const storage = options.storage ?? memory();
  const ui = (s: IndexSnapshot) => {
    const view: ConnectionView = { state: 'live', snapshot: s };
    return (
      <ApiContext.Provider value={api}>
        <AttachContext.Provider value={attach}>
          <Dashboard view={view} navigation={navigation} storage={storage} />
        </AttachContext.Provider>
      </ApiContext.Provider>
    );
  };
  const result = render(ui(first));
  return { ...result, history, fetch, sockets, update: (next: IndexSnapshot) => result.rerender(ui(next)) };
}

/** The window's width, which the layout follows. */
function setWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

const settle = () => act(async () => {});
const nextFrame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

const rowButton = (name: string) => within(screen.getByRole('main')).getByRole('button', { name });
/** The session view, as a region (three columns) or a dialog (over the list). */
const view = () => (document.getElementById('session-view') as HTMLElement | null) ?? undefined;
const viewName = () => {
  const shown = view();
  return shown ? document.getElementById(shown.getAttribute('aria-labelledby')!)?.querySelector('.session-view-name')?.textContent : undefined;
};
const heading = () => document.getElementById(view()!.getAttribute('aria-labelledby')!)!;
const listHeading = () => within(screen.getByRole('main')).getByRole('heading', { level: 2 });
const posts = (fetch: ReturnType<typeof fakeServer>) => fetch.mock.calls.filter(([, init]) => init.method === 'POST');
const conversationsOf = (fetch: ReturnType<typeof fakeServer>, sessionId: string) =>
  fetch.mock.calls.filter(([url, init]) => init.method !== 'POST' && url.includes(sessionId)).length;

async function open(name: string) {
  fireEvent.click(rowButton(name));
  await settle();
}

beforeEach(() => {
  terminals.length = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
});

describe('the open session in the URL', () => {
  it('opening from a row pushes ?session=, after the selection; opening another pushes again', async () => {
    const { history } = renderDashboard();
    await open('demo-a');
    expect(history.entries).toEqual(['?view=all', `?view=all&session=${A}`]);
    await open('demo-c');
    expect(history.entries).toEqual(['?view=all', `?view=all&session=${A}`, `?view=all&session=${C}`]);
    expect(viewName()).toBe('demo-c');
  });

  it('moving with ↑ and ↓ replaces the entry, from a row and from the header', async () => {
    const { history } = renderDashboard();
    await open('demo-a');
    fireEvent.keyDown(rowButton('demo-a'), { key: 'ArrowDown' });
    await settle();
    expect(history.entries).toEqual(['?view=all', `?view=all&session=${B}`]);
    fireEvent.keyDown(heading(), { key: 'ArrowDown' });
    await settle();
    expect(history.entries).toEqual(['?view=all', `?view=all&session=${C}`]);
    expect(viewName()).toBe('demo-c');
  });

  it('closing pushes an entry without it, keeping the selection', async () => {
    const { history } = renderDashboard();
    await open('demo-a');
    fireEvent.click(within(view()!).getByRole('button', { name: 'Close' }));
    expect(history.entries).toEqual(['?view=all', `?view=all&session=${A}`, '?view=all']);
    expect(view()).toBeUndefined();
  });

  it('follows the back and forward buttons', async () => {
    const { history } = renderDashboard();
    await open('demo-a');
    await open('demo-b');
    fireEvent.click(within(view()!).getByRole('button', { name: 'Close' }));

    history.back();
    await settle();
    expect(viewName()).toBe('demo-b');
    history.back();
    await settle();
    expect(viewName()).toBe('demo-a');
    history.back();
    await settle();
    expect(view()).toBeUndefined();
    history.forward();
    await settle();
    expect(viewName()).toBe('demo-a');
  });

  it('opens the view a loaded URL names, and nothing else: no attach, no message, no stop or remove, and no focus taken', async () => {
    const { fetch, sockets } = renderDashboard(snap(), { search: `?view=all&session=${B}` });
    await settle();
    expect(viewName()).toBe('demo-b');
    expect(within(view()!).getByRole('tab', { name: 'Conversation' }).getAttribute('aria-selected')).toBe('true');
    expect(sockets.sockets).toHaveLength(0);
    expect(posts(fetch)).toEqual([]);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([`/api/sessions/${B}/conversation`]);
    expect(document.activeElement).toBe(document.body);
  });

  it("shows 'This session isn't listed under these roots' for an id that isn't, with Close", async () => {
    const { history, fetch } = renderDashboard(snap(), { search: '?view=all&session=pitwall-test-unknown' });
    await settle();
    const shown = screen.getByRole('dialog', { name: "This session isn't listed under these roots" });
    expect(shown.textContent).toContain('pitwall-test-unknown');
    expect(fetch).not.toHaveBeenCalled();

    fireEvent.click(within(shown).getByRole('button', { name: 'Close' }));
    expect(view()).toBeUndefined();
    expect(history.location.search).toBe('?view=all');
  });

  it('waits for the first snapshot before saying a session is not listed', async () => {
    const history = fakeHistory(`?view=all&session=${A}`);
    const { rerender } = render(<Dashboard view={{ state: 'connecting' }} navigation={history.navigation} storage={memory()} />);
    expect(view()).toBeUndefined();
    rerender(<Dashboard view={{ state: 'live', snapshot: snap() }} navigation={history.navigation} storage={memory()} />);
    await settle();
    expect(viewName()).toBe('demo-a');
  });

  it('keeps showing a session that leaves the snapshot, and the back button returns to it as it showed last', async () => {
    const { update, history } = renderDashboard();
    await open('demo-a');
    await open('demo-c');
    update(snap(sessions().filter((each) => each.sessionId !== A)));
    history.back();
    await settle();
    expect(viewName()).toBe('demo-a');
    expect(within(view()!).getByText('This session is no longer listed, so this is what it showed last.')).toBeTruthy();
  });

  it("selects a ?session='s group when the URL names no selection, and opens it", async () => {
    const { history } = renderDashboard(snap(), { search: `?session=${C}` });
    await settle();
    expect(history.location.search).toBe(`?repo=/Users/example/code/demo-app&session=${C}`);
    expect(viewName()).toBe('demo-c');
  });

  it('never puts the token in the query string: the app takes it from the fragment first', async () => {
    window.history.replaceState(null, '', `/?view=all&session=${A}#token=${TOKEN}`);
    const fake = fakeSockets();
    render(<App createSocket={fake.factory} fetch={fakeServer()} />);
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe(`?view=all&session=${A}`);
    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe(TOKEN);
    act(() => {
      fake.last.open();
      fake.last.receive({ type: 'challenge', version: PROTOCOL_VERSION, nonce: 'n'.repeat(43) });
    });
    await waitFor(() => expect(fake.last.sent).toHaveLength(1));
    act(() => fake.last.receive({ type: 'authenticated', apiKey: API_KEY }));
    act(() => fake.last.receive({ type: 'snapshot', snapshot: snap() }));
    await settle();
    expect(viewName()).toBe('demo-a');

    await open('demo-b');
    fireEvent.click(within(view()!).getByRole('button', { name: 'Close' }));
    expect(window.location.href).not.toContain(TOKEN);
    expect(window.location.search).toBe('?view=all');
  });
});

describe('focus', () => {
  it("opening from a row moves focus to the view's heading, which shows no ring; closing gives it back to the row", async () => {
    setWidth(1300);
    renderDashboard();
    await open('demo-a');
    expect(document.activeElement).toBe(heading());
    expect(heading().tabIndex).toBe(-1);
    fireEvent.click(within(view()!).getByRole('button', { name: 'Close' }));
    // In three columns the row is there at once.
    expect(document.activeElement).toBe(rowButton('demo-a'));
  });

  it("opening the open session's row again focuses its heading again", async () => {
    setWidth(1300);
    renderDashboard();
    await open('demo-a');
    rowButton('demo-a').focus();
    await open('demo-a');
    expect(document.activeElement).toBe(heading());
  });

  it("gives focus to the session list's heading when the row isn't shown", async () => {
    setWidth(1300);
    renderDashboard();
    await open('demo-a');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter sessions' }), { target: { value: 'demo-c' } });
    fireEvent.click(within(view()!).getByRole('button', { name: 'Close' }));
    expect(document.activeElement).toBe(listHeading());
  });

  it('leaves focus alone when the back button closes the view while focus is elsewhere', async () => {
    const { history } = renderDashboard();
    await open('demo-a');
    const filter = screen.getByRole('searchbox', { name: 'Filter sessions' });
    filter.focus();
    history.back();
    await nextFrame();
    expect(view()).toBeUndefined();
    expect(document.activeElement).toBe(filter);
  });
});

describe('↑ and ↓', () => {
  it('on a row, move focus to the next or previous row, stop at the ends, skip a collapsed Finished section, and open nothing with the view closed', async () => {
    const { history } = renderDashboard();
    rowButton('demo-a').focus();
    const press = (key: string) => fireEvent.keyDown(document.activeElement!, { key });
    expect(press('ArrowUp')).toBe(false);
    expect(document.activeElement).toBe(rowButton('demo-a'));
    press('ArrowDown');
    expect(document.activeElement).toBe(rowButton('demo-b'));
    press('ArrowDown');
    press('ArrowDown');
    // The finished row is behind the collapsed toggle, so C is the last.
    expect(document.activeElement).toBe(rowButton('demo-c'));
    press('ArrowUp');
    expect(document.activeElement).toBe(rowButton('demo-b'));
    expect(view()).toBeUndefined();
    expect(history.entries).toEqual(['?view=all']);

    fireEvent.click(screen.getByRole('button', { name: /^Finished/ }));
    rowButton('demo-c').focus();
    press('ArrowDown');
    expect(document.activeElement).toBe(rowButton('demo-done'));
  });

  it('on a row with the view open, also show that session, with focus left in the list', async () => {
    const { fetch } = renderDashboard();
    await open('demo-a');
    rowButton('demo-a').focus();
    fireEvent.keyDown(rowButton('demo-a'), { key: 'ArrowDown' });
    await settle();
    expect(viewName()).toBe('demo-b');
    expect(document.activeElement).toBe(rowButton('demo-b'));
    expect(conversationsOf(fetch, B)).toBe(1);
  });

  it("in the view's header, show the next or previous session, with focus on its heading, stopping at the ends", async () => {
    renderDashboard();
    await open('demo-b');
    fireEvent.keyDown(heading(), { key: 'ArrowUp' });
    await settle();
    expect(viewName()).toBe('demo-a');
    expect(document.activeElement).toBe(heading());
    fireEvent.keyDown(heading(), { key: 'ArrowUp' });
    await settle();
    expect(viewName()).toBe('demo-a');

    // From the header's other controls too, such as the copy button.
    fireEvent.keyDown(within(view()!).getByRole('button', { name: 'Copy path' }), { key: 'ArrowDown' });
    await settle();
    expect(viewName()).toBe('demo-b');
  });

  it('move inside an open menu instead of changing session', async () => {
    renderDashboard();
    await open('demo-b');
    fireEvent.click(within(view()!).getByRole('button', { name: 'Session actions' }));
    const [first, second] = within(view()!).getAllByRole('menuitem');
    fireEvent.keyDown(first!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(second);
    expect(viewName()).toBe('demo-b');
  });
});

describe('Escape, nearest first', () => {
  it('closes an open menu, then the view', async () => {
    renderDashboard();
    await open('demo-b');
    fireEvent.click(within(view()!).getByRole('button', { name: 'Session actions' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(within(view()!).queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(within(view()!).getByRole('button', { name: 'Session actions' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(view()).toBeUndefined();
  });

  it('clears the filter while it is focused and has text, and only then closes the view', async () => {
    renderDashboard();
    await open('demo-a');
    const filter = screen.getByRole('searchbox', { name: 'Filter sessions' });
    fireEvent.change(filter, { target: { value: 'demo' } });
    filter.focus();
    fireEvent.keyDown(filter, { key: 'Escape' });
    expect((filter as HTMLInputElement).value).toBe('');
    expect(viewName()).toBe('demo-a');
    fireEvent.keyDown(filter, { key: 'Escape' });
    expect(view()).toBeUndefined();
  });

  it('closes the New session dialog over the view, and not the view', async () => {
    renderDashboard();
    await open('demo-a');
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'New session' })).toBeNull();
    expect(viewName()).toBe('demo-a');
  });

  it('never discards a draft in the message box', async () => {
    renderDashboard();
    await open('demo-a');
    const box = within(view()!).getByRole('textbox', { name: 'Message to demo-a' });
    fireEvent.change(box, { target: { value: 'a draft' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(viewName()).toBe('demo-a');
    expect((box as HTMLTextAreaElement).value).toBe('a draft');
    fireEvent.change(box, { target: { value: '' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(view()).toBeUndefined();
  });

  it('closes the view from anywhere else, Back included at 600 px and narrower', async () => {
    setWidth(375);
    renderDashboard();
    await open('demo-a');
    expect(within(view()!).queryByRole('button', { name: 'Close' })).toBeNull();
    fireEvent.click(within(view()!).getByRole('button', { name: 'Back to sessions' }));
    expect(view()).toBeUndefined();
    await nextFrame();
    expect(document.activeElement).toBe(rowButton('demo-a'));
  });
});

describe('the tabs', () => {
  it('are a tablist of Conversation and Terminal, with roving tabindex, each controlling its tab panel', async () => {
    renderDashboard();
    await open('demo-b');
    const list = within(view()!).getByRole('tablist', { name: 'Session view' });
    const [conversation, terminal] = within(list).getAllByRole('tab');
    expect(conversation?.textContent).toBe('Conversation');
    expect(terminal?.textContent).toBe('Terminal');
    expect(conversation?.getAttribute('aria-selected')).toBe('true');
    expect(terminal?.getAttribute('aria-selected')).toBe('false');
    expect([conversation?.tabIndex, terminal?.tabIndex]).toEqual([0, -1]);
    for (const tab of [conversation!, terminal!]) {
      const panel = document.getElementById(tab.getAttribute('aria-controls')!)!;
      expect(panel.getAttribute('role')).toBe('tabpanel');
      expect(panel.getAttribute('aria-labelledby')).toBe(tab.id);
    }
    // The conversation is a Tab stop, so it can be scrolled from the keyboard.
    expect(document.getElementById(conversation!.getAttribute('aria-controls')!)!.tabIndex).toBe(0);
  });

  it('move focus with ← → Home End, and open only on Enter or Space, as a click', async () => {
    const { sockets } = renderDashboard();
    await open('demo-b');
    const [conversation, terminal] = within(view()!).getAllByRole('tab');
    conversation!.focus();
    fireEvent.keyDown(conversation!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(terminal);
    fireEvent.keyDown(terminal!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(conversation);
    fireEvent.keyDown(conversation!, { key: 'End' });
    expect(document.activeElement).toBe(terminal);
    fireEvent.keyDown(terminal!, { key: 'Home' });
    expect(document.activeElement).toBe(conversation);
    fireEvent.keyDown(conversation!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(terminal);
    await settle();
    expect(sockets.sockets).toHaveLength(0);
    expect(terminal!.getAttribute('aria-selected')).toBe('false');

    fireEvent.click(terminal!);
    await waitFor(() => expect(sockets.sockets).toHaveLength(1));
    expect(terminal!.getAttribute('aria-selected')).toBe('true');
    expect([conversation?.tabIndex, terminal?.tabIndex]).toEqual([-1, 0]);
  });
});

describe('the divider', () => {
  const divider = () => screen.getByRole('separator', { name: 'Resize the session view' });
  const pane = () => document.querySelector<HTMLElement>('.session-pane')!;

  it('is a focusable vertical separator whose value is the view’s width, in three columns only', () => {
    setWidth(1440);
    renderDashboard();
    expect(divider().getAttribute('aria-orientation')).toBe('vertical');
    expect(divider().tabIndex).toBe(0);
    expect([divider().getAttribute('aria-valuenow'), divider().getAttribute('aria-valuemin'), divider().getAttribute('aria-valuemax')]).toEqual(['760', '560', '840']);
    expect(pane().style.width).toBe('760px');

    setWidth(1100);
    expect(screen.queryByRole('separator', { name: 'Resize the session view' })).toBeNull();
    expect(pane().style.width).toBe('');
  });

  it('moves 16 px with ← and →, jumps to the limits with Home and End, and stores each width', () => {
    setWidth(1440);
    const storage = memory();
    renderDashboard(snap(), { storage });
    const press = (key: string) => fireEvent.keyDown(divider(), { key });
    press('ArrowLeft');
    expect(divider().getAttribute('aria-valuenow')).toBe('776');
    expect(storage.values.get(PANEL_WIDTH_KEY)).toBe('776');
    press('ArrowRight');
    press('ArrowRight');
    expect(divider().getAttribute('aria-valuenow')).toBe('744');
    press('Home');
    expect(divider().getAttribute('aria-valuenow')).toBe('560');
    press('ArrowRight');
    expect(divider().getAttribute('aria-valuenow')).toBe('560');
    press('End');
    expect(divider().getAttribute('aria-valuenow')).toBe('840');
    press('ArrowLeft');
    expect(divider().getAttribute('aria-valuenow')).toBe('840');
    expect(storage.values.get(PANEL_WIDTH_KEY)).toBe('840');
    expect(pane().style.width).toBe('840px');
  });

  it('resets to 760 px on a double-click, or the maximum when that is less', () => {
    setWidth(1440);
    const storage = memory({ [PANEL_WIDTH_KEY]: '600' });
    renderDashboard(snap(), { storage });
    fireEvent.doubleClick(divider());
    expect(divider().getAttribute('aria-valuenow')).toBe('760');

    setWidth(1300);
    fireEvent.doubleClick(divider());
    expect(divider().getAttribute('aria-valuenow')).toBe('700');
    expect(storage.values.get(PANEL_WIDTH_KEY)).toBe('700');
  });

  it('resizes as it is dragged, within the limits, and stores the width when the drag ends', () => {
    setWidth(1440);
    const storage = memory();
    renderDashboard(snap(), { storage });
    fireEvent.pointerDown(divider(), { button: 0, clientX: 600, pointerId: 1 });
    expect(document.activeElement).toBe(divider());
    fireEvent.pointerMove(divider(), { clientX: 500, pointerId: 1 });
    expect(divider().getAttribute('aria-valuenow')).toBe('840');
    fireEvent.pointerMove(divider(), { clientX: 640, pointerId: 1 });
    expect(divider().getAttribute('aria-valuenow')).toBe('720');
    expect(storage.values.has(PANEL_WIDTH_KEY)).toBe(false);
    fireEvent.pointerUp(divider(), { clientX: 640, pointerId: 1 });
    expect(storage.values.get(PANEL_WIDTH_KEY)).toBe('720');
    fireEvent.pointerMove(divider(), { clientX: 0, pointerId: 1 });
    expect(divider().getAttribute('aria-valuenow')).toBe('720');
  });

  it('shows a stored width clamped to the window, keeping the setting, and reads pitwall.panel-width.v1 safely', () => {
    setWidth(1300);
    renderDashboard(snap(), { storage: memory({ [PANEL_WIDTH_KEY]: '900' }) });
    expect(divider().getAttribute('aria-valuenow')).toBe('700');
    // The stylesheet clamps it: the pane asks for the stored width.
    expect(pane().style.width).toBe('900px');

    for (const raw of ['abc', '100', '559', '99999999', '-700', '7e2', '']) {
      expect(readPanelWidth(memory({ [PANEL_WIDTH_KEY]: raw })), raw).toBe(760);
    }
    expect(readPanelWidth(memory({ [PANEL_WIDTH_KEY]: '612' }))).toBe(612);
    const throwing: StorageSource = () => {
      throw new Error('blocked');
    };
    expect(readPanelWidth(throwing)).toBe(760);
  });
});

describe('crossing 1,200 px with the view open', () => {
  it('keeps the same view, its conversation and its terminal: nothing remounts, reloads or detaches', async () => {
    setWidth(1300);
    const { fetch, sockets } = renderDashboard();
    await open('demo-b');
    const shown = view()!;
    expect(shown.getAttribute('role')).toBeNull();
    expect(shown.className).toContain('in-column');
    fireEvent.click(within(shown).getByRole('tab', { name: 'Terminal' }));
    await waitFor(() => expect(sockets.sockets).toHaveLength(1));

    setWidth(1100);
    await settle();
    expect(view()).toBe(shown);
    expect(shown.getAttribute('role')).toBe('dialog');
    expect(shown.getAttribute('aria-modal')).toBe('false');
    expect(shown.className).toContain('overlay');
    // Not slid in again: it didn't open, it moved.
    expect(shown.className).not.toContain('opening');

    setWidth(1440);
    await settle();
    expect(view()).toBe(shown);
    expect(conversationsOf(fetch, B)).toBe(1);
    expect(sockets.sockets).toHaveLength(1);
    expect(sockets.last.closedByClient).toBe(false);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.disposed).toBe(false);
  });

  it('slides in when it opens over the list, and not as ↑ and ↓ move it from one session to the next', async () => {
    setWidth(1100);
    renderDashboard();
    await open('demo-a');
    expect(view()!.className).toContain('opening');
    fireEvent.animationEnd(view()!);
    expect(view()!.className).not.toContain('opening');

    fireEvent.keyDown(heading(), { key: 'ArrowDown' });
    await settle();
    expect(viewName()).toBe('demo-b');
    expect(view()!.className).not.toContain('opening');
  });
});
