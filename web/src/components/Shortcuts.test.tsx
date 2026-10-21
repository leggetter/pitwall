// The single-key shortcuts in the app (W26, docs/design-system.md, 6.2): `/`, `n`, `?`, `j` and `k`
// from the list, the session view's header and its conversation; ignored while typing, with a
// modifier held and over a dialog; closing an open menu first; and the off switch, stored as
// pitwall.shortcuts.v1. Made-up sessions only.

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationPage, IndexSnapshot, SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import { AttachContext, type AttachEnv } from '../attach.js';
import type { ConnectionView } from '../connection.js';
import type { StorageSource } from '../groupState.js';
import { createShortcutsStore, SHORTCUTS_KEY, ShortcutsStoreContext, type ShortcutsStore } from '../shortcuts.js';
import { fakeSockets, group, minutesAgo, NOW, session, snapshot } from '../test/fixtures.js';
import { fakeHistory } from '../test/history.js';
import { hover, pass, unhover } from '../test/tooltips.js';
import { Dashboard } from './Dashboard.js';
import type { TerminalHandle } from './Terminal.js';

// xterm.js, replaced by a terminal that does nothing, through the module the view loads it from.
class QuietTerminal implements TerminalHandle {
  cols = 80;
  rows = 24;
  write() {}
  onData() {}
  fit() {}
  focus() {}
  dispose() {}
}
vi.mock('../xterm.js', () => ({ createXterm: () => new QuietTerminal() }));

const API_KEY = 'k'.repeat(43);
const TOKEN = 'pitwall-test-token-0123456789abcdefghijklmnop';
const id = (n: number) => `00000000-0000-4000-8000-0000000026${String(n).padStart(2, '0')}`;
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

/** Another tab's `storage` events, sent by hand. */
function tabs() {
  const listeners: ((event: { key: string | null }) => void)[] = [];
  return {
    addEventListener: (_type: 'storage', listener: (event: { key: string | null }) => void) => void listeners.push(listener),
    fire: (key: string | null) =>
      act(() => {
        for (const listener of listeners) listener({ key });
      }),
  };
}

interface Options {
  search?: string;
  /** Where the shortcuts setting is kept. */
  stored?: StorageSource & { values?: Map<string, string> };
  store?: ShortcutsStore;
  view?: Partial<ConnectionView>;
}

/** `null` renders the dashboard before its first snapshot. */
function renderDashboard(first: IndexSnapshot | null = snap(), options: Options = {}) {
  const history = fakeHistory(options.search ?? '?view=all');
  const fetch = fakeServer();
  const api = createApiClient({ apiKey: API_KEY, fetch });
  const sockets = fakeSockets();
  const attach: AttachEnv = { token: TOKEN, createSocket: sockets.factory, host: '127.0.0.1:4517' };
  const storage = memory();
  const shortcutStorage: StorageSource & { values?: Map<string, string> } = options.stored ?? memory();
  const events = tabs();
  const store = options.store ?? createShortcutsStore({ storage: shortcutStorage, events });
  const ui = (s: IndexSnapshot | null) => {
    const view: ConnectionView = s ? { state: 'live', snapshot: s, ...options.view } : { state: 'connecting', ...options.view };
    return (
      <ShortcutsStoreContext.Provider value={store}>
        <ApiContext.Provider value={api}>
          <AttachContext.Provider value={attach}>
            <Dashboard view={view} navigation={history.navigation} storage={storage} />
          </AttachContext.Provider>
        </ApiContext.Provider>
      </ShortcutsStoreContext.Provider>
    );
  };
  const result = render(ui(first));
  return { ...result, history, fetch, store, events, shortcutStorage, update: (next: IndexSnapshot) => result.rerender(ui(next)) };
}

/** The window's width, which the layout follows. */
function setWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

const settle = () => act(async () => {});

/**
 * Presses `key` on what has focus, or on `target`, as the browser sends it. Returns whether the
 * browser would go on to do what the key does, which a shortcut stops (preventDefault).
 */
function press(key: string, target: Element | null = document.activeElement, init: KeyboardEventInit = {}): boolean {
  let unhandled = true;
  act(() => {
    unhandled = fireEvent.keyDown(target ?? document.body, { key, ...init });
  });
  return unhandled;
}

const rowButton = (name: string) => within(screen.getByRole('main')).getByRole('button', { name });
const view = () => (document.getElementById('session-view') as HTMLElement | null) ?? undefined;
const viewName = () => view()?.querySelector('.session-view-name')?.textContent ?? undefined;
const heading = () => document.getElementById(view()!.getAttribute('aria-labelledby')!)!;
const conversation = () => view()!.querySelector<HTMLElement>('.session-view-body[role="tabpanel"]')!;
const filterField = () => screen.getByRole('searchbox', { name: 'Filter sessions' }) as HTMLInputElement;
const dialog = (name: string) => screen.queryByRole('dialog', { name });
const SHORTCUT_KEYS = ['/', 'n', '?', 'j', 'k'];

async function open(name: string) {
  fireEvent.click(rowButton(name));
  await settle();
}

/** Puts focus nowhere, as after a click on the page's background. */
function blur() {
  (document.activeElement as HTMLElement | null)?.blur();
  expect(document.activeElement).toBe(document.body);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
});

describe('/', () => {
  it("focuses the filter field from the page, a row, the session view's header and its conversation, and isn't typed", async () => {
    setWidth(1300);
    renderDashboard();
    expect(press('/', document.body)).toBe(false);
    expect(document.activeElement).toBe(filterField());
    expect(filterField().value).toBe('');

    rowButton('demo-a').focus();
    expect(press('/')).toBe(false);
    expect(document.activeElement).toBe(filterField());

    await open('demo-a');
    expect(document.activeElement).toBe(heading());
    expect(press('/')).toBe(false);
    expect(document.activeElement).toBe(filterField());
    expect(viewName()).toBe('demo-a');

    conversation().focus();
    expect(press('/')).toBe(false);
    expect(document.activeElement).toBe(filterField());
    expect(viewName()).toBe('demo-a');
  });

  it('puts the caret after any text already there, so the filter can be refined', () => {
    setWidth(1300);
    renderDashboard();
    fireEvent.change(filterField(), { target: { value: 'demo' } });
    blur();
    press('/', document.body);
    expect(document.activeElement).toBe(filterField());
    expect([filterField().selectionStart, filterField().selectionEnd]).toEqual([4, 4]);
  });

  it('below 1,200 px, closes the session view over the list first, unless its message box has a draft', async () => {
    const { history } = renderDashboard();
    await open('demo-a');
    expect(press('/')).toBe(false);
    expect(view()).toBeUndefined();
    expect(document.activeElement).toBe(filterField());
    expect(history.entries.at(-1)).toBe('?view=all');

    await open('demo-a');
    const box = within(view()!).getByRole('textbox', { name: 'Message to demo-a' });
    fireEvent.change(box, { target: { value: 'a draft' } });
    conversation().focus();
    expect(press('/')).toBe(true);
    expect(viewName()).toBe('demo-a');
    expect(document.activeElement).toBe(conversation());
    expect((box as HTMLTextAreaElement).value).toBe('a draft');
  });

  it('does nothing while there is no filter field, before the first snapshot', () => {
    renderDashboard(null);
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(press('/', document.body)).toBe(true);
    expect(document.activeElement).toBe(document.body);
  });
});

describe('n', () => {
  it('opens the New session dialog from a row and from the conversation, and Escape gives focus back', async () => {
    setWidth(1300);
    renderDashboard();
    rowButton('demo-b').focus();
    expect(press('n')).toBe(false);
    const shown = dialog('New session')!;
    expect(shown.contains(document.activeElement)).toBe(true);
    press('Escape');
    expect(dialog('New session')).toBeNull();
    expect(document.activeElement).toBe(rowButton('demo-b'));

    await open('demo-a');
    conversation().focus();
    press('n');
    expect(dialog('New session')).not.toBeNull();
    press('Escape');
    expect(document.activeElement).toBe(conversation());
    expect(viewName()).toBe('demo-a');
  });

  it('ignores n repeating as it is held, and does nothing before the first snapshot', () => {
    const { rerender } = renderDashboard();
    expect(press('n', document.body, { repeat: true })).toBe(true);
    expect(dialog('New session')).toBeNull();
    rerender(<Dashboard view={{ state: 'connecting' }} navigation={fakeHistory('?view=all').navigation} storage={memory()} />);
    expect(press('n', document.body)).toBe(true);
    expect(dialog('New session')).toBeNull();
  });
});

describe('?', () => {
  it('opens the keyboard shortcuts dialog, as the header button does, and Escape gives focus back, leaving the view open', async () => {
    setWidth(1300);
    renderDashboard();
    await open('demo-a');
    expect(press('?', heading(), { shiftKey: true })).toBe(false);
    expect(dialog('Keyboard shortcuts')).not.toBeNull();
    press('Escape');
    expect(dialog('Keyboard shortcuts')).toBeNull();
    expect(document.activeElement).toBe(heading());
    expect(viewName()).toBe('demo-a');

    const button = within(document.querySelector<HTMLElement>('.app-header')!).getByRole('button', { name: 'Keyboard shortcuts' });
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    // Not aria-keyshortcuts="?": ARIA 1.2 wants the keys pressed, and ? is Shift and a key that differs by layout.
    expect(button.hasAttribute('aria-keyshortcuts')).toBe(false);
    button.focus();
    fireEvent.click(button);
    expect(dialog('Keyboard shortcuts')).not.toBeNull();
    press('Escape');
    expect(document.activeElement).toBe(button);
  });

  it('ignores ? repeating as it is held, and works before the first snapshot', () => {
    renderDashboard(null);
    expect(press('?', document.body, { repeat: true })).toBe(true);
    expect(dialog('Keyboard shortcuts')).toBeNull();
    press('?', document.body);
    expect(dialog('Keyboard shortcuts')).not.toBeNull();
  });
});

describe('j and k', () => {
  it('with no session open, move focus through the rows as shown, from the first, stopping at the ends and skipping a collapsed Finished section', () => {
    const { history } = renderDashboard();
    expect(press('j', document.body)).toBe(false);
    expect(document.activeElement).toBe(rowButton('demo-a'));
    press('j');
    expect(document.activeElement).toBe(rowButton('demo-b'));
    press('j');
    expect(document.activeElement).toBe(rowButton('demo-c'));
    // The finished row is behind the collapsed toggle, so C is the last: no wrapping.
    expect(press('j')).toBe(true);
    expect(document.activeElement).toBe(rowButton('demo-c'));
    press('k');
    press('k');
    expect(document.activeElement).toBe(rowButton('demo-a'));
    expect(press('k')).toBe(true);
    expect(document.activeElement).toBe(rowButton('demo-a'));
    expect(view()).toBeUndefined();
    expect(history.entries).toEqual(['?view=all']);

    fireEvent.click(screen.getByRole('button', { name: /^Finished/ }));
    rowButton('demo-c').focus();
    press('j');
    expect(document.activeElement).toBe(rowButton('demo-done'));
  });

  it('k with nothing focused starts at the first row too', () => {
    renderDashboard();
    press('k', document.body);
    expect(document.activeElement).toBe(rowButton('demo-a'));
  });

  it('skip the rows the filter hides', () => {
    renderDashboard();
    fireEvent.click(screen.getByRole('button', { name: 'Interactive' }));
    rowButton('demo-a').focus();
    press('j');
    expect(document.activeElement).toBe(rowButton('demo-c'));
    press('k');
    expect(document.activeElement).toBe(rowButton('demo-a'));
  });

  it('follow the order on screen while it is held, not the new one', () => {
    const { update } = renderDashboard();
    press('j', document.body);
    expect(document.activeElement).toBe(rowButton('demo-a'));
    // C now needs you, so Urgency puts it first, but focus is in the list, so the order holds.
    const next = sessions().map((s) => (s.sessionId === C ? { ...s, status: 'waiting' as const, waitingFor: 'permission prompt' } : s));
    update(snap(next));
    const shown = () => [...screen.getByRole('main').querySelectorAll('[data-open-session]')].filter((button) => !button.closest('[hidden]')).map((button) => button.textContent);
    expect(shown()).toEqual(['demo-a', 'demo-b', 'demo-c']);
    press('j');
    expect(document.activeElement).toBe(rowButton('demo-b'));
    press('j');
    expect(document.activeElement).toBe(rowButton('demo-c'));
  });

  it('with a session open, show the next or previous one; from the list, focus stays in the list', async () => {
    // In three columns: below 1,200 px the view covers the list, which is inert, so focus can't be there.
    setWidth(1300);
    const { history, fetch } = renderDashboard();
    await open('demo-a');
    const entries = history.entries.length;
    rowButton('demo-a').focus();
    press('j');
    await settle();
    expect(viewName()).toBe('demo-b');
    expect(document.activeElement).toBe(rowButton('demo-b'));
    expect(history.entries.length).toBe(entries);
    expect(history.entries.at(-1)).toBe(`?view=all&session=${B}`);
    expect(fetch.mock.calls.some(([url]) => url.includes(B))).toBe(true);
  });

  it("from the view's header, show the next or previous session with focus on its heading, stopping at the ends", async () => {
    renderDashboard();
    await open('demo-a');
    expect(document.activeElement).toBe(heading());
    expect(press('k')).toBe(true);
    expect(viewName()).toBe('demo-a');
    press('j');
    await settle();
    expect(viewName()).toBe('demo-b');
    expect(document.activeElement).toBe(heading());
    within(view()!).getByRole('button', { name: 'Copy path' }).focus();
    press('j');
    await settle();
    expect(viewName()).toBe('demo-c');
    expect(document.activeElement).toBe(heading());
    expect(press('j')).toBe(true);
    expect(viewName()).toBe('demo-c');
  });

  it("from the conversation, show the next session and keep focus in its conversation, where ↑ and ↓ scroll", async () => {
    renderDashboard();
    await open('demo-a');
    conversation().focus();
    press('j');
    await settle();
    expect(viewName()).toBe('demo-b');
    expect(document.activeElement).toBe(conversation());
    press('k');
    await settle();
    expect(viewName()).toBe('demo-a');
    expect(document.activeElement).toBe(conversation());
  });

  it('with nothing focused and a session open, show the next one, with focus on its heading', async () => {
    renderDashboard();
    await open('demo-a');
    blur();
    press('j', document.body);
    await settle();
    expect(viewName()).toBe('demo-b');
    expect(document.activeElement).toBe(heading());
  });

  it('do nothing while the message box has a draft, which would be lost', async () => {
    renderDashboard();
    await open('demo-a');
    const box = within(view()!).getByRole('textbox', { name: 'Message to demo-a' });
    fireEvent.change(box, { target: { value: 'a draft' } });
    conversation().focus();
    expect(press('j')).toBe(true);
    rowButton('demo-a').focus();
    expect(press('j')).toBe(true);
    expect(viewName()).toBe('demo-a');
    expect((box as HTMLTextAreaElement).value).toBe('a draft');
  });

  it("do nothing for an open session the list doesn't show", async () => {
    renderDashboard();
    fireEvent.click(screen.getByRole('button', { name: /^Finished/ }));
    await open('demo-done');
    fireEvent.click(screen.getByRole('button', { name: /^Finished/ }));
    heading().focus();
    expect(press('j')).toBe(true);
    expect(press('k')).toBe(true);
    expect(viewName()).toBe('demo-done');
  });
});

describe('ignored', () => {
  /** Presses every shortcut on `target`, and checks none did anything. */
  function pressesNothing(target: Element, init: KeyboardEventInit = {}) {
    const before = { focus: document.activeElement, view: viewName(), filter: filterField().value };
    for (const key of SHORTCUT_KEYS) expect(press(key, target, init), `${key} on ${target.tagName}`).toBe(true);
    expect(document.activeElement).toBe(before.focus);
    expect(viewName()).toBe(before.view);
    expect(filterField().value).toBe(before.filter);
    expect(dialog('New session')).toBeNull();
    expect(dialog('Keyboard shortcuts')).toBeNull();
  }

  it('while typing: in the filter field, the message box, the Sort select, something contenteditable and the terminal', async () => {
    setWidth(1300);
    const { container } = renderDashboard();
    await open('demo-a');
    filterField().focus();
    pressesNothing(filterField());
    const box = within(view()!).getByRole('textbox', { name: 'Message to demo-a' });
    box.focus();
    pressesNothing(box);
    const sort = screen.getByRole('combobox', { name: 'Sort' });
    sort.focus();
    pressesNothing(sort);
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    editable.tabIndex = 0;
    container.querySelector('.app')!.append(editable);
    editable.focus();
    pressesNothing(editable);
    // The terminal: xterm.js takes keys in a textarea inside .xterm, and the screen beside it.
    const terminal = document.createElement('div');
    terminal.className = 'xterm';
    terminal.innerHTML = '<div class="xterm-screen" tabindex="0"></div>';
    view()!.append(terminal);
    const screenElement = terminal.firstElementChild as HTMLElement;
    screenElement.focus();
    pressesNothing(screenElement);
  });

  it('with ⌘, Ctrl or Alt held, so the browser and the system keep their shortcuts', async () => {
    setWidth(1300);
    renderDashboard();
    await open('demo-a');
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey']) pressesNothing(heading(), { [modifier]: true });
  });

  it('while a dialog is open: New session, the shortcuts dialog, and the repo drawer', async () => {
    setWidth(1300);
    renderDashboard();
    await open('demo-a');
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    const close = within(dialog('New session')!).getByRole('button', { name: 'Close' });
    close.focus();
    for (const key of SHORTCUT_KEYS) expect(press(key)).toBe(true);
    expect(document.activeElement).toBe(close);
    expect(dialog('Keyboard shortcuts')).toBeNull();
    press('Escape');

    press('?', document.body);
    const box = within(dialog('Keyboard shortcuts')!).getByRole('checkbox', { name: 'Single-key shortcuts' });
    expect(document.activeElement).toBe(box);
    for (const key of SHORTCUT_KEYS) expect(press(key)).toBe(true);
    expect(document.activeElement).toBe(box);
    expect(screen.getAllByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveLength(1);
    expect(viewName()).toBe('demo-a');
    press('Escape');

    setWidth(375);
    fireEvent.click(screen.getByRole('button', { name: 'Repos' }));
    const drawer = screen.getByRole('dialog', { name: 'Repos' });
    expect(drawer.contains(document.activeElement)).toBe(true);
    const inDrawer = document.activeElement;
    for (const key of SHORTCUT_KEYS) expect(press(key)).toBe(true);
    expect(document.activeElement).toBe(inDrawer);
  });
});

describe('an open menu', () => {
  it('closes first when a shortcut moves focus: j, /, n and ?', async () => {
    setWidth(1300);
    renderDashboard();
    await open('demo-b');
    const menuButton = () => within(view()!).getByRole('button', { name: 'Session actions' });
    const menu = () => within(view()!).queryByRole('menu');

    fireEvent.click(menuButton());
    expect(menu()?.contains(document.activeElement)).toBe(true);
    press('j');
    await settle();
    expect(menu()).toBeNull();
    expect(viewName()).toBe('demo-c');
    expect(document.activeElement).toBe(heading());

    fireEvent.click(menuButton());
    press('/');
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(filterField());

    fireEvent.click(menuButton());
    press('n');
    expect(menu()).toBeNull();
    expect(dialog('New session')).not.toBeNull();
    press('Escape');
    // Back where the menu put focus as it closed: its button.
    expect(document.activeElement).toBe(menuButton());

    fireEvent.click(menuButton());
    press('?');
    expect(menu()).toBeNull();
    expect(dialog('Keyboard shortcuts')).not.toBeNull();
    press('Escape');
    expect(document.activeElement).toBe(menuButton());
  });

  it("stays open when the shortcut has nowhere to go, as j at the list's end", async () => {
    setWidth(1300);
    renderDashboard();
    await open('demo-c');
    fireEvent.click(within(view()!).getByRole('button', { name: 'Session actions' }));
    expect(press('j')).toBe(true);
    expect(within(view()!).queryByRole('menu')).not.toBeNull();
  });
});

describe('the off switch', () => {
  it('is on by default; turning it off stores it and turns off all five, and the header button still opens the dialog', async () => {
    setWidth(1300);
    const { shortcutStorage } = renderDashboard();
    await open('demo-a');
    press('?', heading());
    const box = () => within(dialog('Keyboard shortcuts')!).getByRole('checkbox', { name: 'Single-key shortcuts' }) as HTMLInputElement;
    expect(box().checked).toBe(true);
    fireEvent.click(box());
    expect(box().checked).toBe(false);
    expect(shortcutStorage.values?.get(SHORTCUTS_KEY)).toBe('off');
    press('Escape');
    expect(document.activeElement).toBe(heading());

    for (const target of [heading(), conversation(), document.body]) {
      if (target === document.body) blur();
      else (target as HTMLElement).focus();
      for (const key of SHORTCUT_KEYS) expect(press(key, target), key).toBe(true);
      expect(viewName()).toBe('demo-a');
      expect(dialog('New session')).toBeNull();
      expect(dialog('Keyboard shortcuts')).toBeNull();
      expect(document.activeElement).toBe(target);
    }

    fireEvent.click(within(document.querySelector<HTMLElement>('.app-header')!).getByRole('button', { name: 'Keyboard shortcuts' }));
    expect(box().checked).toBe(false);
    fireEvent.click(box());
    expect(shortcutStorage.values?.get(SHORTCUTS_KEY)).toBe('on');
    press('Escape');
    heading().focus();
    press('j');
    await settle();
    expect(viewName()).toBe('demo-b');
  });

  it('reads a stored off back when the page loads', () => {
    renderDashboard(snap(), { stored: memory({ [SHORTCUTS_KEY]: 'off' }) });
    expect(press('j', document.body)).toBe(true);
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(within(document.querySelector<HTMLElement>('.app-header')!).getByRole('button', { name: 'Keyboard shortcuts' }));
    expect((within(dialog('Keyboard shortcuts')!).getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });

  it('follows a change made in another tab', () => {
    const stored = memory();
    const { events } = renderDashboard(snap(), { stored });
    expect(document.querySelector('.filter-key')).not.toBeNull();
    stored.values.set(SHORTCUTS_KEY, 'off');
    events.fire(SHORTCUTS_KEY);
    expect(document.querySelector('.filter-key')).toBeNull();
    expect(press('j', document.body)).toBe(true);
    stored.values.set(SHORTCUTS_KEY, 'on');
    events.fire(SHORTCUTS_KEY);
    press('j', document.body);
    expect(document.activeElement).toBe(rowButton('demo-a'));
  });

  it("works for the page when storage throws, and they're on to start with", () => {
    const throwing: StorageSource = () => ({
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    renderDashboard(snap(), { stored: throwing });
    press('?', document.body);
    const box = within(dialog('Keyboard shortcuts')!).getByRole('checkbox') as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(box.checked).toBe(false);
    press('Escape');
    expect(press('j', document.body)).toBe(true);
  });

  it("hides the filter field's / and the single-key caps in tooltips; Esc still shows", async () => {
    setWidth(1300);
    const { store } = renderDashboard();
    const banner = within(document.querySelector<HTMLElement>('.app-header')!);
    const caps = (tip: HTMLElement | null) => [...(tip?.querySelectorAll('kbd') ?? [])].map((kbd) => kbd.textContent);

    // On: the key cap in the empty field, and n and ? in the tooltips.
    expect(caps(document.querySelector('.filter-key'))).toEqual(['/']);
    expect(filterField().getAttribute('aria-keyshortcuts')).toBe('/');
    const newSession = banner.getByRole('button', { name: 'New session' });
    expect(newSession.getAttribute('aria-keyshortcuts')).toBe('n');
    expect(caps(await hover(newSession))).toEqual(['n']);
    unhover(newSession);
    await pass(0);
    const keyboard = banner.getByRole('button', { name: 'Keyboard shortcuts' });
    const tip = await hover(keyboard);
    expect(tip?.querySelector('.tooltip-text')?.textContent).toBe('Keyboard shortcuts');
    expect(caps(tip)).toEqual(['?']);
    unhover(keyboard);
    await pass(0);
    // The key cap goes once there's text.
    fireEvent.change(filterField(), { target: { value: 'demo' } });
    expect(document.querySelector('.filter-key')).toBeNull();
    fireEvent.change(filterField(), { target: { value: '' } });

    act(() => store.set(false));
    expect(document.querySelector('.filter-key')).toBeNull();
    expect(filterField().hasAttribute('aria-keyshortcuts')).toBe(false);
    expect(newSession.hasAttribute('aria-keyshortcuts')).toBe(false);
    expect(keyboard.hasAttribute('aria-keyshortcuts')).toBe(false);
    // New session's tooltip would only repeat its label, so there's none.
    expect(await hover(newSession)).toBeNull();
    unhover(newSession);
    await pass(0);
    const off = await hover(keyboard);
    expect(off?.querySelector('.tooltip-text')?.textContent).toBe('Keyboard shortcuts');
    expect(caps(off)).toEqual([]);
    unhover(keyboard);
    await pass(0);
    await open('demo-a');
    const close = within(view()!).getByRole('button', { name: 'Close' });
    expect(caps(await hover(close))).toEqual(['Esc']);
  });
});
