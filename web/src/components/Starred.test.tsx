// Starred sessions (W53, docs/design-system.md, 4: Starred sessions): the star toggle on each row and
// in the session view's header, its name and state; the repo list's Starred view, under each root tab,
// with its count, the sort, ?view=starred through a reload, its empty state and its Finished section;
// unstarring there; pitwall.starred.v1 through a reload, malformed or throwing, capped, ids only, never
// pruned, and another tab's change; and `s`, ignored while typing, in the terminal and when the
// single-key shortcuts are off. Made-up sessions only.

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexSnapshot, SessionSummary } from '../../../src/shared/protocol.js';
import { FINISHED_STATE_KEY, type StorageSource } from '../groupState.js';
import { memoryNavigation, type NavigationEnv } from '../selection.js';
import { createShortcutsStore, ShortcutsStoreContext, type ShortcutsStore } from '../shortcuts.js';
import { SORT_KEY } from '../sort.js';
import { STARRED_CAP, STARRED_KEY } from '../starred.js';
import { group, minutesAgo, NOW, session, snapshot } from '../test/fixtures.js';
import { toastMessages } from '../test/toasts.js';
import { Dashboard, NO_STARRED, starredText } from './Dashboard.js';
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

const ROOT = '/Users/example/code';
const WORK = '/Users/example/work';
const id = (n: number) => `00000000-0000-4000-8000-0000000053${String(n).padStart(2, '0')}`;
const done = { kind: 'background' as const, shortId: 'd53', alive: false, pid: undefined, status: undefined, state: 'done' as const, finished: true };

/** Five made-up sessions in two groups under ~/code: alpha needs you, gamma has finished. */
function sessions() {
  const alpha = session({ sessionId: id(1), name: 'alpha', title: 'A made-up export fix', status: 'waiting', waitingFor: 'permission prompt', lastActivityAt: minutesAgo(9), lastUserPrompt: 'A made-up prompt for alpha' });
  const beta = session({ sessionId: id(2), name: 'beta', cwd: `${ROOT}/app`, lastActivityAt: minutesAgo(1) });
  const delta = session({ sessionId: id(4), name: 'delta', cwd: `${ROOT}/app`, lastActivityAt: minutesAgo(3) });
  const gamma = session({ sessionId: id(3), name: 'gamma', cwd: `${ROOT}/jobs`, ...done, lastActivityAt: minutesAgo(30) });
  const epsilon = session({ sessionId: id(5), name: 'epsilon', cwd: `${ROOT}/jobs`, lastActivityAt: minutesAgo(5) });
  return { alpha, beta, gamma, delta, epsilon };
}

function snap(list = sessions()): IndexSnapshot {
  return snapshot([
    group({ key: `${ROOT}/app`, label: 'app', sessions: [list.alpha, list.beta, list.delta] }),
    group({ key: `${ROOT}/jobs`, label: 'jobs', sessions: [list.gamma, list.epsilon] }),
  ]);
}

/** Two roots, a session under each starred later: ~/code's api-one, and ~/work's svc-one. */
function twoRoots(): IndexSnapshot {
  return snapshot(
    [
      group({ key: `${ROOT}/api`, label: 'api', root: ROOT, sessions: [session({ sessionId: id(11), name: 'api-one', cwd: `${ROOT}/api` }), session({ sessionId: id(12), name: 'api-two', cwd: `${ROOT}/api` })] }),
      group({ key: `${WORK}/svc`, label: 'svc', root: WORK, sessions: [session({ sessionId: id(21), name: 'svc-one', cwd: `${WORK}/svc`, status: 'waiting' })] }),
    ],
    { roots: [ROOT, WORK] },
  );
}

/** localStorage-like storage that lasts for the test, so a reload is a new Dashboard on the same storage. */
function memory(initial: Record<string, string> = {}) {
  const items = new Map<string, string>(Object.entries(initial));
  const source: StorageSource = () => ({ getItem: (name) => items.get(name) ?? null, setItem: (name, value) => void items.set(name, value) });
  return { items, source };
}

const stars = (items: Map<string, string>) => JSON.parse(items.get(STARRED_KEY) ?? '{"v":1,"ids":[]}') as { v: number; ids: string[] };

interface Options {
  search?: string;
  storage?: StorageSource;
  navigation?: NavigationEnv;
  shortcuts?: ShortcutsStore;
}

function renderDashboard(first: IndexSnapshot = snap(), options: Options = {}) {
  const store = memory();
  const storage = options.storage ?? store.source;
  const navigation = options.navigation ?? memoryNavigation(options.search ?? '?view=all');
  const shortcuts = options.shortcuts ?? createShortcutsStore({ storage: memory().source, events: { addEventListener: () => {} } });
  const ui = (s: IndexSnapshot) => (
    <ShortcutsStoreContext.Provider value={shortcuts}>
      <Dashboard view={{ state: 'live', snapshot: s }} navigation={navigation} storage={storage} />
    </ShortcutsStoreContext.Provider>
  );
  const result = render(ui(first));
  return { ...result, items: store.items, navigation, shortcuts, again: (next: IndexSnapshot) => result.rerender(ui(next)) };
}

const settle = () => act(async () => {});
const main = () => screen.getByRole('main');
const repoList = () => screen.getByRole('navigation', { name: 'Repos' });
const listHeading = () => within(main()).getByRole('heading', { level: 2 });
const rowNames = () => within(main()).queryAllByRole('heading', { level: 3 }).map((heading) => heading.textContent ?? '');
const summary = () => document.querySelector('.session-list .summary')?.textContent ?? '';
const view = () => document.getElementById('session-view') ?? undefined;
const viewName = () => view()?.querySelector('.session-view-name')?.textContent ?? undefined;
const rowStar = (name: string) => within(main()).getByRole('button', { name: `Star ${name}` });
const viewStar = () => within(view()!).getByRole('button', { name: `Star ${viewName()}` });
const rowButton = (name: string) => within(main()).getByRole('button', { name });
const pressed = (button: HTMLElement) => button.getAttribute('aria-pressed');

function repoItem(label: string): HTMLAnchorElement {
  const item = [...repoList().querySelectorAll<HTMLAnchorElement>('a[data-repo-item]')].find((link) => link.querySelector('.repo-item-label')?.textContent === label);
  if (!item) throw new Error(`no repo list item ${label}`);
  return item;
}

function choose(label: string) {
  fireEvent.click(repoItem(label));
}

const finishedToggle = () => within(main()).queryByRole('button', { name: /^Finished/ });

async function open(name: string) {
  fireEvent.click(rowButton(name));
  await settle();
}

/** Presses `key` on `target`; returns whether the browser would go on to do what it does. */
function press(key: string, target: Element | null = document.activeElement, init: KeyboardEventInit = {}): boolean {
  let unhandled = true;
  act(() => {
    unhandled = fireEvent.keyDown(target ?? document.body, { key, ...init });
  });
  return unhandled;
}

function setWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
});

describe('the star toggle on a row', () => {
  it("is a toggle button on every row, finished ones too, named for its session, and not pressed", () => {
    renderDashboard();
    fireEvent.click(finishedToggle()!);
    for (const name of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) {
      const star = rowStar(name);
      expect(star.tagName).toBe('BUTTON');
      expect(star.getAttribute('type')).toBe('button');
      expect(pressed(star)).toBe('false');
      expect(star.closest('li.session')?.querySelector('.session-line')?.lastElementChild).toBe(star);
    }
  });

  it('stars and unstars, its name the same either way, and never opens or selects the session', () => {
    const { items, navigation } = renderDashboard();
    const star = rowStar('beta');
    star.focus();
    fireEvent.click(star);
    expect(pressed(rowStar('beta'))).toBe('true');
    expect(rowStar('beta')).toBe(star);
    expect(document.activeElement).toBe(star);
    expect(star.querySelector('svg path')?.getAttribute('d')).not.toBe(rowStar('delta').querySelector('svg path')?.getAttribute('d'));
    expect(star.closest('li.session')?.classList.contains('starred')).toBe(true);
    expect(stars(items)).toEqual({ v: 1, ids: [id(2)] });
    expect(view()).toBeUndefined();
    expect(navigation.location.search).toBe('?view=all');
    expect(listHeading().textContent).toBe('All sessions');

    fireEvent.click(star);
    expect(pressed(rowStar('beta'))).toBe('false');
    expect(star.closest('li.session')?.classList.contains('starred')).toBe(false);
    expect(stars(items).ids).toEqual([]);
    expect(view()).toBeUndefined();
  });

  it("keeps an open session's view as it is, and opens none, in a group's list too", async () => {
    setWidth(1300);
    const { navigation } = renderDashboard(snap(), { search: `?repo=${ROOT}/app` });
    await open('beta');
    const search = navigation.location.search;
    fireEvent.click(rowStar('delta'));
    expect(viewName()).toBe('beta');
    expect(navigation.location.search).toBe(search);
    expect(pressed(rowStar('delta'))).toBe('true');
  });
});

describe("the star toggle in the session view's header", () => {
  it('sits before the actions menu, named for its session, and follows the row', async () => {
    setWidth(1300);
    const { items } = renderDashboard();
    await open('alpha');
    const star = viewStar();
    const menu = within(view()!).getByRole('button', { name: 'Session actions' });
    // In line 1, after the heading and just before the actions menu.
    expect(star.closest('.session-view-top')).not.toBeNull();
    expect(star.compareDocumentPosition(menu) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const buttons: HTMLElement[] = [...view()!.querySelector('.session-view-top')!.querySelectorAll('button')];
    expect(buttons.indexOf(menu) - buttons.indexOf(star)).toBe(1);
    expect(pressed(star)).toBe('false');
    expect(star.classList.contains('md')).toBe(true);

    fireEvent.click(star);
    expect(pressed(viewStar())).toBe('true');
    expect(pressed(rowStar('alpha'))).toBe('true');
    expect(stars(items).ids).toEqual([id(1)]);
    expect(viewName()).toBe('alpha');

    fireEvent.click(rowStar('alpha'));
    expect(pressed(viewStar())).toBe('false');
  });

  it('says s in its tooltip and aria-keyshortcuts while the single-key shortcuts are on, and neither while they are off', async () => {
    setWidth(1300);
    const { shortcuts } = renderDashboard();
    await open('alpha');
    expect(viewStar().getAttribute('aria-keyshortcuts')).toBe('s');
    expect(rowStar('alpha').hasAttribute('aria-keyshortcuts')).toBe(false);
    act(() => shortcuts.set(false));
    expect(viewStar().hasAttribute('aria-keyshortcuts')).toBe(false);
  });
});

describe('the Starred view', () => {
  it('comes after All sessions, before the divider, counting nothing until a session is starred', () => {
    renderDashboard();
    const views = [...repoList().querySelector('ul.repo-items')!.querySelectorAll('a[data-repo-item]')].map((link) => link.querySelector('.repo-item-label')?.textContent);
    expect(views).toEqual(['Needs you', 'All sessions', 'Starred']);
    expect(repoItem('Starred').textContent).toBe('Starred');
    expect(repoItem('Starred').getAttribute('href')).toBe('?view=starred');
    expect(repoItem('Starred').querySelector('svg')).toBeNull();

    fireEvent.click(rowStar('beta'));
    fireEvent.click(rowStar('delta'));
    expect(repoItem('Starred').textContent).toBe('Starred2 sessions');
    // Like a group: a badge once any of them needs you.
    fireEvent.click(rowStar('alpha'));
    expect(repoItem('Starred').textContent).toBe('Starred1 needs you');
  });

  it('lists only the starred sessions, each with its group, with the summary, and ?view=starred in the URL', () => {
    const { navigation } = renderDashboard();
    fireEvent.click(rowStar('alpha'));
    fireEvent.click(rowStar('epsilon'));
    choose('Starred');
    expect(navigation.location.search).toBe('?view=starred');
    expect(listHeading().textContent).toBe('Starred');
    expect(rowNames()).toEqual(['alpha', 'epsilon']);
    expect(summary()).toBe('2 sessions1 needs you');
    expect(main().querySelector('.session-group')?.textContent).toBe('app');
    expect(repoItem('Starred').getAttribute('aria-current')).toBe('page');
  });

  it('sorts as the Sort setting says, as the other lists do', () => {
    renderDashboard();
    for (const name of ['beta', 'delta', 'epsilon', 'alpha']) fireEvent.click(rowStar(name));
    choose('Starred');
    // Urgency: what needs you first, then the most recently active.
    expect(rowNames()).toEqual(['alpha', 'beta', 'delta', 'epsilon']);
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort' }), { target: { value: 'name' } });
    expect(rowNames()).toEqual(['alpha', 'beta', 'delta', 'epsilon']);
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort' }), { target: { value: 'recent' } });
    expect(rowNames()).toEqual(['beta', 'delta', 'epsilon', 'alpha']);
  });

  it('takes the stored Sort setting, and the filter, as other lists do', () => {
    const store = memory({ [SORT_KEY]: 'recent', [STARRED_KEY]: JSON.stringify({ v: 1, ids: [id(1), id(4)] }) });
    renderDashboard(snap(), { storage: store.source, search: '?view=starred' });
    expect(rowNames()).toEqual(['delta', 'alpha']);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter sessions' }), { target: { value: 'export' } });
    expect(rowNames()).toEqual(['alpha']);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter sessions' }), { target: { value: 'nowhere' } });
    expect(screen.getByText('Nothing in Starred matches "nowhere".')).toBeTruthy();
  });

  it('shows Starred again after a reload, from ?view=starred, with the stars kept', () => {
    const store = memory();
    const first = renderDashboard(snap(), { storage: store.source });
    fireEvent.click(rowStar('beta'));
    fireEvent.click(rowStar('epsilon'));
    choose('Starred');
    const search = first.navigation.location.search;
    first.unmount();

    renderDashboard(snap(), { storage: store.source, navigation: memoryNavigation(search) });
    expect(listHeading().textContent).toBe('Starred');
    expect(rowNames()).toEqual(['beta', 'epsilon']);
    expect(pressed(rowStar('beta'))).toBe('true');
  });

  it("puts a starred finished session in Starred's own Finished section, collapsed at first, and remembers it", () => {
    const store = memory({ [STARRED_KEY]: JSON.stringify({ v: 1, ids: [id(3), id(2)] }) });
    const first = renderDashboard(snap(), { storage: store.source, search: '?view=starred' });
    // gamma is in the collapsed section, so it isn't shown.
    expect(rowNames()).toEqual(['beta']);
    const toggle = finishedToggle()!;
    expect(toggle.textContent).toContain('Finished (1)');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(rowNames()).toEqual(['beta', 'gamma']);
    expect(JSON.parse(store.items.get(FINISHED_STATE_KEY)!)).toMatchObject({ 'view:starred': true });
    first.unmount();
    renderDashboard(snap(), { storage: store.source, search: '?view=starred' });
    expect(finishedToggle()!.getAttribute('aria-expanded')).toBe('true');
    // All sessions' own stays as it was.
    choose('All sessions');
    expect(finishedToggle()!.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows an empty state that says how to star, with no summary, and Show all sessions', () => {
    renderDashboard(snap(), { search: '?view=starred' });
    expect(screen.getByText(NO_STARRED.title)).toBeTruthy();
    expect(screen.getByText('Star a session from its row or its view to keep it here.')).toBeTruthy();
    expect(summary()).toBe('');
    expect(rowNames()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Show all sessions' }));
    expect(listHeading().textContent).toBe('All sessions');
    expect(document.activeElement).toBe(listHeading());
  });

  it('shows the empty state too when the starred sessions are none of these', () => {
    const store = memory({ [STARRED_KEY]: JSON.stringify({ v: 1, ids: ['00000000-0000-4000-8000-00000000dead'] }) });
    renderDashboard(snap(), { storage: store.source, search: '?view=starred' });
    expect(screen.getByText(NO_STARRED.title)).toBeTruthy();
    expect(repoItem('Starred').textContent).toBe('Starred');
  });

  it('lets a row go at once when it is unstarred there, focus moving to the star of the row that took its place, then to the heading', () => {
    const store = memory({ [STARRED_KEY]: JSON.stringify({ v: 1, ids: [id(2), id(4), id(5)] }) });
    renderDashboard(snap(), { storage: store.source, search: '?view=starred' });
    expect(rowNames()).toEqual(['beta', 'delta', 'epsilon']);
    rowStar('beta').focus();
    fireEvent.click(rowStar('beta'));
    expect(rowNames()).toEqual(['delta', 'epsilon']);
    expect(document.activeElement).toBe(rowStar('delta'));
    // So Space or Enter, pressed again, unstars the next.
    fireEvent.click(document.activeElement!);
    expect(rowNames()).toEqual(['epsilon']);
    expect(document.activeElement).toBe(rowStar('epsilon'));
    fireEvent.click(document.activeElement!);
    expect(screen.getByText(NO_STARRED.title)).toBeTruthy();
    expect(document.activeElement).toBe(listHeading());
    expect(JSON.parse(store.items.get(STARRED_KEY)!).ids).toEqual([]);
  });

  it('moves focus to the star before when the last row is unstarred from its star', () => {
    const store = memory({ [STARRED_KEY]: JSON.stringify({ v: 1, ids: [id(2), id(4)] }) });
    renderDashboard(snap(), { storage: store.source, search: '?view=starred' });
    rowStar('delta').focus();
    fireEvent.click(rowStar('delta'));
    expect(rowNames()).toEqual(['beta']);
    expect(document.activeElement).toBe(rowStar('beta'));
  });

  it('keeps an open session open when it is unstarred there', async () => {
    setWidth(1300);
    const store = memory({ [STARRED_KEY]: JSON.stringify({ v: 1, ids: [id(2), id(4)] }) });
    renderDashboard(snap(), { storage: store.source, search: '?view=starred' });
    await open('beta');
    fireEvent.click(viewStar());
    expect(rowNames()).toEqual(['delta']);
    expect(viewName()).toBe('beta');
    expect(pressed(viewStar())).toBe('false');
  });

  it('is walked with j and k, as the other lists are, from a row or its star', () => {
    const store = memory({ [STARRED_KEY]: JSON.stringify({ v: 1, ids: [id(2), id(5)] }) });
    renderDashboard(snap(), { storage: store.source, search: '?view=starred' });
    (document.activeElement as HTMLElement | null)?.blur();
    press('j', document.body);
    expect(document.activeElement).toBe(rowButton('beta'));
    press('j');
    expect(document.activeElement).toBe(rowButton('epsilon'));
    press('j');
    expect(document.activeElement).toBe(rowButton('epsilon'));
    rowStar('epsilon').focus();
    press('k');
    expect(document.activeElement).toBe(rowButton('beta'));
  });
});

describe('the Starred view under root tabs', () => {
  it("lists and counts only the open tab's starred sessions, with the root in the URL; the stars are every root's", () => {
    const { items, navigation } = renderDashboard(twoRoots(), { search: `?view=all&root=${ROOT}` });
    fireEvent.click(rowStar('api-one'));
    fireEvent.click(screen.getAllByRole('tab')[1]!);
    fireEvent.click(rowStar('svc-one'));
    expect(stars(items).ids).toEqual([id(11), id(21)]);
    expect(repoItem('Starred').textContent).toBe('Starred1 needs you');
    choose('Starred');
    expect(navigation.location.search).toBe(`?view=starred&root=${WORK}`);
    expect(rowNames()).toEqual(['svc-one']);

    fireEvent.click(screen.getAllByRole('tab')[0]!);
    expect(repoItem('Starred').textContent).toBe('Starred1 session');
    choose('Starred');
    expect(navigation.location.search).toBe(`?view=starred&root=${ROOT}`);
    expect(rowNames()).toEqual(['api-one']);
  });
});

describe('pitwall.starred.v1', () => {
  it('holds the ids alone: no name, title, prompt or path', () => {
    const { items } = renderDashboard();
    fireEvent.click(rowStar('alpha'));
    const raw = items.get(STARRED_KEY)!;
    expect(JSON.parse(raw)).toEqual({ v: 1, ids: [id(1)] });
    expect(raw).not.toMatch(/alpha|made-up|export|Users|app/i);
  });

  it("never prunes a star whose session is missing from a snapshot, as after a failed poll", () => {
    const { items, again } = renderDashboard();
    fireEvent.click(rowStar('beta'));
    again(snapshot([], { source: { ok: false, error: 'a made-up failure' } }));
    again(snapshot([group({ key: `${ROOT}/jobs`, label: 'jobs', sessions: [sessions().epsilon] })]));
    expect(stars(items).ids).toEqual([id(2)]);
    again(snap());
    expect(pressed(rowStar('beta'))).toBe('true');
  });

  it('holds its cap, dropping the oldest star, however many came before', () => {
    const old = Array.from({ length: STARRED_CAP }, (_, n) => `00000000-0000-4000-8000-0000000099${String(n).padStart(2, '0')}`);
    const store = memory({ [STARRED_KEY]: JSON.stringify({ v: 1, ids: old }) });
    renderDashboard(snap(), { storage: store.source });
    fireEvent.click(rowStar('beta'));
    const kept = JSON.parse(store.items.get(STARRED_KEY)!).ids as string[];
    expect(kept).toHaveLength(STARRED_CAP);
    expect(kept.at(-1)).toBe(id(2));
    expect(kept[0]).toBe(old[1]);
  });

  it("doesn't break the page when it's malformed: nothing is starred, and a star replaces it", () => {
    for (const raw of ['not json', '{"v":1,"ids":"alpha"}', '[1,2]', '{"v":9,"ids":["x"]}']) {
      const store = memory({ [STARRED_KEY]: raw });
      const { unmount } = renderDashboard(snap(), { storage: store.source, search: '?view=starred' });
      expect(screen.getByText(NO_STARRED.title)).toBeTruthy();
      choose('All sessions');
      fireEvent.click(rowStar('beta'));
      expect(JSON.parse(store.items.get(STARRED_KEY)!)).toEqual({ v: 1, ids: [id(2)] });
      unmount();
    }
  });

  it("doesn't break the page when storage throws: stars last for the page's life", () => {
    const denied = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    renderDashboard(snap(), { storage: () => ({ getItem: denied, setItem: denied }), search: '?view=starred' });
    expect(screen.getByText(NO_STARRED.title)).toBeTruthy();
    choose('All sessions');
    fireEvent.click(rowStar('beta'));
    expect(pressed(rowStar('beta'))).toBe('true');
    choose('Starred');
    expect(rowNames()).toEqual(['beta']);
  });

  it('follows a star made in another tab, with the window’s storage event', () => {
    const store = memory();
    renderDashboard(snap(), { storage: store.source });
    store.items.set(STARRED_KEY, JSON.stringify({ v: 1, ids: [id(4)] }));
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: STARRED_KEY }));
    });
    expect(pressed(rowStar('delta'))).toBe('true');
    expect(repoItem('Starred').textContent).toBe('Starred1 session');
  });
});

describe('s', () => {
  it('stars and unstars the open session, from its header and its conversation, with a toast, and focus stays', async () => {
    setWidth(1300);
    const { items } = renderDashboard();
    await open('beta');
    const heading = document.getElementById(view()!.getAttribute('aria-labelledby')!)!;
    heading.focus();
    expect(press('s')).toBe(false);
    expect(pressed(viewStar())).toBe('true');
    expect(pressed(rowStar('beta'))).toBe('true');
    expect(stars(items).ids).toEqual([id(2)]);
    expect(toastMessages()).toContain(starredText('beta', true));
    expect(toastMessages()).toContain('Starred beta.');
    expect(document.activeElement).toBe(heading);

    const body = view()!.querySelector<HTMLElement>('.session-view-body[role="tabpanel"]')!;
    body.focus();
    expect(press('s')).toBe(false);
    expect(pressed(viewStar())).toBe('false');
    expect(toastMessages()).toContain('Unstarred beta.');
    expect(document.activeElement).toBe(body);
  });

  it('does nothing with no session open, from the page or a row', () => {
    const { items } = renderDashboard();
    expect(press('s', document.body)).toBe(true);
    rowButton('beta').focus();
    expect(press('s')).toBe(true);
    expect(items.get(STARRED_KEY)).toBeUndefined();
    expect(within(main()).queryAllByRole('button', { pressed: true })).toEqual([]);
  });

  it('is ignored while typing, in the terminal, held down, with a modifier, and while the single-key shortcuts are off', async () => {
    setWidth(1300);
    const { items, container, shortcuts } = renderDashboard();
    await open('alpha');
    const nothing = (target: Element, init: KeyboardEventInit = {}) => {
      expect(press('s', target, init), target.className).toBe(true);
      expect(pressed(viewStar())).toBe('false');
      expect(items.get(STARRED_KEY)).toBeUndefined();
    };
    const filter = screen.getByRole('searchbox', { name: 'Filter sessions' });
    filter.focus();
    nothing(filter);
    const box = within(view()!).getByRole('textbox', { name: 'Message to alpha' });
    box.focus();
    nothing(box);
    const terminal = document.createElement('div');
    terminal.className = 'xterm';
    terminal.innerHTML = '<div class="xterm-screen" tabindex="0"></div>';
    view()!.append(terminal);
    const screenElement = terminal.firstElementChild as HTMLElement;
    screenElement.focus();
    nothing(screenElement);
    terminal.remove();

    const heading = document.getElementById(view()!.getAttribute('aria-labelledby')!)!;
    heading.focus();
    nothing(heading, { repeat: true });
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey']) nothing(heading, { [modifier]: true });
    act(() => shortcuts.set(false));
    nothing(heading);
    expect(container.querySelector('.toast')).toBeNull();

    act(() => shortcuts.set(true));
    expect(press('s', heading)).toBe(false);
    expect(pressed(viewStar())).toBe('true');
  });
});

describe('a row stays as it was', () => {
  it('two lines, with its star at the end of line 1, after the time', () => {
    renderDashboard();
    const line = rowStar('beta').closest('.session-line')!;
    expect([...line.children].map((child) => child.className.split(' ')[0])).toEqual(['session-ident', 'activity', 'icon-button']);
    expect(rowStar('beta').classList.contains('sm')).toBe(true);
  });

  it('lists a session with a starred row the same in every view, only its star pressed', () => {
    renderDashboard();
    fireEvent.click(rowStar('alpha'));
    for (const label of ['Needs you', 'All sessions', 'app', 'Starred']) {
      choose(label);
      expect(pressed(rowStar('alpha')), label).toBe('true');
    }
  });

  it('shows the name as text: a star for a session whose name has markup names it as written', () => {
    const odd: SessionSummary = session({ sessionId: id(9), name: '<b>odd</b>', cwd: `${ROOT}/app` });
    renderDashboard(snapshot([group({ key: `${ROOT}/app`, label: 'app', sessions: [odd] })]));
    expect(rowStar('<b>odd</b>')).toBeTruthy();
    expect(main().querySelector('b')).toBeNull();
  });
});
