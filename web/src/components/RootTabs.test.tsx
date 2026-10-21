// Roots as tabs (W38): with two or more roots, a tab per root in the header, each narrowing the repo
// list, the session list, the filter, j and k, and the New session dialog to its root; an inactive
// tab's need-you badge; each tab's own place, with its session view kept while hidden; the URL and
// the back button; the stored tab; the keyboard; and one root inside another. Made-up sessions only.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationPage, IndexSnapshot, SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import { AttachContext, type AttachEnv } from '../attach.js';
import type { StorageSource } from '../groupState.js';
import { ROOT_TAB_KEY } from '../rootTabs.js';
import { VIEW_STATE_KEY } from '../selection.js';
import { fakeSockets, group, minutesAgo, NOW, session, snapshot } from '../test/fixtures.js';
import { fakeHistory } from '../test/history.js';
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

const WORK = '/Users/example/work';
const PERSONAL = '/Users/example/personal';
const SCRATCH = '/Users/example/scratch';
const at = (root: string, name: string) => `${root}/${name}`;
const id = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

const waiting = { status: 'waiting', waitingFor: 'permission prompt' } as const;

/**
 * Two roots. Under ~/work: api, with w1 and `shared` needing you (shared started in api and worked in
 * web, but is listed in api alone, W39), and web; so ~/work's Needs you is 2 and its All sessions 5.
 * Under ~/personal: blog and the root's own directory, with p2 needing you; 1 and 3.
 */
function sessions() {
  const w1 = session({ sessionId: id(1), name: 'w-one', cwd: at(WORK, 'api'), ...waiting, lastActivityAt: minutesAgo(1) });
  const w2 = session({ sessionId: id(2), name: 'w-two', cwd: at(WORK, 'api'), lastActivityAt: minutesAgo(2) });
  const shared = session({
    sessionId: id(3),
    name: 'w-shared',
    cwd: at(WORK, 'api'),
    askedYou: { reason: 'question', excerpt: 'Keep the made-up flag?' },
    workedIn: [{ key: at(WORK, 'web'), label: 'web', root: WORK, calls: 12, changes: 1, lastAt: minutesAgo(3) }],
    lastActivityAt: minutesAgo(3),
  });
  const w3 = session({ sessionId: id(4), name: 'w-three', cwd: at(WORK, 'web'), lastActivityAt: minutesAgo(4) });
  const bg = session({ sessionId: id(5), name: 'w-job', kind: 'background', shortId: 'pt0005', state: 'working', status: undefined, cwd: at(WORK, 'web'), lastActivityAt: minutesAgo(5) });
  const p1 = session({ sessionId: id(11), name: 'p-one', cwd: at(PERSONAL, 'blog'), lastActivityAt: minutesAgo(1) });
  const p2 = session({ sessionId: id(12), name: 'p-two', cwd: at(PERSONAL, 'blog'), ...waiting, lastActivityAt: minutesAgo(2) });
  const p3 = session({ sessionId: id(13), name: 'p-three', cwd: PERSONAL, lastActivityAt: minutesAgo(3) });
  return { w1, w2, shared, w3, bg, p1, p2, p3 };
}

function twoRoots(list = sessions(), extra: Partial<IndexSnapshot> = {}): IndexSnapshot {
  const { w1, w2, shared, w3, bg, p1, p2, p3 } = list;
  return snapshot(
    [
      group({ key: at(WORK, 'api'), label: 'api', root: WORK, sessions: [w1, shared, w2] }),
      group({ key: at(WORK, 'web'), label: 'web', root: WORK, sessions: [w3, bg] }),
      group({ key: at(PERSONAL, 'blog'), label: 'blog', root: PERSONAL, sessions: [p2, p1] }),
      group({ key: PERSONAL, label: 'personal', kind: 'directory', root: PERSONAL, sessions: [p3] }),
    ],
    { roots: [WORK, PERSONAL], ...extra },
  );
}

/** Three roots, the third with no sessions. */
const threeRoots = () => ({ ...twoRoots(), roots: [WORK, PERSONAL, SCRATCH] });

function memory(entries: Record<string, string> = {}): StorageSource & { values: Map<string, string> } {
  const values = new Map(Object.entries(entries));
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
  return Object.assign(() => storage, { values });
}

/** A relay send that waits until the test answers it; every other POST is refused; every GET is a page of one entry. */
function fakeServer() {
  const relays: { url: string; answer: (status: string) => void }[] = [];
  const fetch = vi.fn<FetchLike>(async (url, init) => {
    if (init.method === 'POST' && url.endsWith('/relay')) {
      return new Promise<Response>((resolve) => relays.push({ url, answer: (status) => resolve(new Response(JSON.stringify({ status }), { status: 200 })) }));
    }
    if (init.method === 'POST' && url === '/api/sessions') return new Response(JSON.stringify({ ok: true, shortId: 'pt0099', name: 'p-new' }), { status: 201 });
    if (init.method === 'POST') return new Response(JSON.stringify({ ok: false, error: 'not in this test' }), { status: 409 });
    const sessionId = decodeURIComponent(url.split('/')[3] ?? '');
    const page: ConversationPage = { sessionId, entries: [{ kind: 'assistant', text: `made-up reply from ${sessionId.slice(-2)}` }] };
    return new Response(JSON.stringify(page), { status: 200 });
  });
  return { fetch, relays };
}

interface Options {
  search?: string;
  storage?: StorageSource;
}

function renderDashboard(first: IndexSnapshot = twoRoots(), options: Options = {}) {
  const history = fakeHistory(options.search ?? '');
  const server = fakeServer();
  const api = createApiClient({ apiKey: 'k'.repeat(43), fetch: server.fetch });
  const sockets = fakeSockets();
  const attach: AttachEnv = { token: 'pitwall-test-token-0123456789abcdefghijklmnop', createSocket: sockets.factory, host: '127.0.0.1:4517' };
  const storage = options.storage ?? memory();
  const ui = (s: IndexSnapshot) => (
    <ApiContext.Provider value={api}>
      <AttachContext.Provider value={attach}>
        <Dashboard view={{ state: 'live', snapshot: s }} navigation={history.navigation} storage={storage} />
      </AttachContext.Provider>
    </ApiContext.Provider>
  );
  const result = render(ui(first));
  return { ...result, history, server, sockets, storage, update: (next: IndexSnapshot) => result.rerender(ui(next)) };
}

function setWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

const settle = () => act(async () => {});

/** The root tabs, by their labels as shown. By text: happy-dom gives spans no display, so a name computed from them gains spaces. */
const tabs = () => screen.queryAllByRole('tab').filter((tab) => tab.classList.contains('root-tab'));
function tab(label: string): HTMLElement {
  const found = tabs().find((candidate) => candidate.querySelector('.root-tab-label')?.textContent === label);
  if (!found) throw new Error(`no root tab ${label}`);
  return found;
}
const labels = () => tabs().map((candidate) => candidate.querySelector('.root-tab-label')?.textContent);
const openTab = () => tabs().find((candidate) => candidate.getAttribute('aria-selected') === 'true')?.querySelector('.root-tab-label')?.textContent;
/** A tab's badge, as it reads: "2 need you", or undefined with none. */
const badge = (label: string) => tab(label).querySelector('.badge')?.textContent?.replace(/^, /, '');
function switchTo(label: string) {
  fireEvent.click(tab(label));
}

const repoList = () => screen.getByRole('navigation', { name: 'Repos' });
/** What each repo list item says, label and count, with the text only screen readers get. */
const repoItems = () => [...repoList().querySelectorAll('a[data-repo-item]')].map((link) => link.textContent ?? '');
function repoItem(label: string): HTMLAnchorElement {
  const item = [...document.querySelectorAll<HTMLAnchorElement>('a[data-repo-item]')].find((link) => link.querySelector('.repo-item-label')?.textContent === label);
  if (!item) throw new Error(`no repo list item ${label}`);
  return item;
}
const choose = (label: string) => fireEvent.click(repoItem(label));
const rows = () => within(screen.getByRole('main')).queryAllByRole('heading', { level: 3 }).map((heading) => heading.textContent ?? '');
const listHeading = () => within(screen.getByRole('main')).getByRole('heading', { level: 2 });
const summary = () => document.querySelector('.session-list .summary')?.textContent ?? '';
const rowButton = (name: string) => within(screen.getByRole('main')).getByRole('button', { name });
async function open(name: string) {
  fireEvent.click(rowButton(name));
  await settle();
}
/** The shown session view, by its id. */
const view = () => (document.getElementById('session-view') as HTMLElement | null) ?? undefined;
const viewName = () => view()?.querySelector('.session-view-name')?.textContent;
/** Every session view on the page, shown or kept hidden, by name. */
const views = () => [...document.querySelectorAll<HTMLElement>('section.session-view')].map((section) => ({ name: section.querySelector('.session-view-name')?.textContent, hidden: section.hidden }));
const search = (history: ReturnType<typeof fakeHistory>) => history.location.search;

beforeEach(() => {
  terminals.length = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  setWidth(1440);
});

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  document.title = 'pitwall';
});

describe('one root', () => {
  it('has no tabs: the header shows the root as it always did, and the URL names no root', () => {
    const { history, storage } = renderDashboard(snapshot([group({ sessions: [session({ name: 'solo', ...waiting })] })]));

    expect(screen.queryByRole('tablist')).toBeNull();
    expect(document.querySelector('header')?.className).toBe('app-header');
    expect(document.querySelector('.roots')?.textContent).toBe('~/code');
    expect(document.querySelector('.columns')?.getAttribute('role')).toBeNull();
    expect(search(history)).toBe('?view=all');
    expect(document.title).toBe('(1) pitwall');
    expect((storage as ReturnType<typeof memory>).values.has(ROOT_TAB_KEY)).toBe(false);
  });

  it('drops a root from a view in the URL, so it reads as before there were tabs', () => {
    const { history } = renderDashboard(snapshot([group({ sessions: [session({ name: 'solo' })] })]), { search: '?view=needs-you&root=/Users/example/code' });
    expect(search(history)).toBe('?view=needs-you');
    expect(repoItem('Needs you').getAttribute('aria-current')).toBe('page');
  });
});

describe('the tabs', () => {
  it('shows a tab per root, in the order pitwall was given them, labelled with its home-shortened path, as a tablist controlling the columns', () => {
    renderDashboard(threeRoots());

    const list = screen.getByRole('tablist', { name: 'Roots' });
    expect(labels()).toEqual(['~/work', '~/personal', '~/scratch']);
    expect(document.querySelector('.roots')).toBeNull();
    expect(document.querySelector('header')?.className).toBe('app-header has-tabs');
    const panel = document.querySelector('.columns') as HTMLElement;
    expect(panel.getAttribute('role')).toBe('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(tab('~/work').id);
    for (const each of tabs()) expect(each.getAttribute('aria-controls')).toBe(panel.id);
    expect(tabs().map((each) => [each.getAttribute('aria-selected'), each.tabIndex])).toEqual([
      ['true', 0],
      ['false', -1],
      ['false', -1],
    ]);
    expect(list.contains(document.querySelector('.brand'))).toBe(false);
  });

  it("opens the first root's tab the first time, and the URL says which tab is open", () => {
    const { history } = renderDashboard();
    expect(openTab()).toBe('~/work');
    expect(search(history)).toBe(`?view=all&root=${WORK}`);
  });

  it("gives each tab its root's full path in a tooltip that describes it", () => {
    renderDashboard();
    const described = tab('~/personal').getAttribute('aria-describedby');
    expect(described && document.getElementById(described)?.textContent).toBe(PERSONAL);
  });

  it('names the open tab’s root in the page title, after the count of everything that needs you under every root', () => {
    renderDashboard();
    expect(document.title).toBe('(3) pitwall · ~/work');
    switchTo('~/personal');
    expect(document.title).toBe('(3) pitwall · ~/personal');
  });
});

describe('what a tab narrows to its root', () => {
  it("narrows the repo list's views, their counts and groups, the session list and its summary", () => {
    renderDashboard();

    expect(repoItems()).toEqual(['Needs you2 need you', 'All sessions5 sessions', 'api, git repo2 need you', 'web, git repo2 sessions']);
    expect(rows().sort()).toEqual(['w-job', 'w-one', 'w-shared', 'w-three', 'w-two']);
    expect(summary()).toBe('5 sessions2 need you');
    choose('Needs you');
    expect(rows().sort()).toEqual(['w-one', 'w-shared']);

    switchTo('~/personal');
    expect(repoItems()).toEqual(['Needs you1 needs you', 'All sessions3 sessions', '~/personal, directory1 session', 'blog, git repo1 needs you']);
    expect(rows().sort()).toEqual(['p-one', 'p-three', 'p-two']);
    expect(summary()).toBe('3 sessions1 needs you');
    choose('Needs you');
    expect(rows()).toEqual(['p-two']);
  });

  it("narrows the filter to the tab's sessions, and each tab keeps its own", () => {
    renderDashboard();
    const field = () => screen.getByRole('searchbox', { name: 'Filter sessions' }) as HTMLInputElement;
    fireEvent.change(field(), { target: { value: 'one' } });
    expect(rows()).toEqual(['w-one']);
    switchTo('~/personal');
    expect(field().value).toBe('');
    fireEvent.change(field(), { target: { value: 'one' } });
    expect(rows()).toEqual(['p-one']);
    switchTo('~/work');
    expect(field().value).toBe('one');
    expect(rows()).toEqual(['w-one']);
  });

  it('moves j and k through the open tab’s list alone', async () => {
    renderDashboard();
    choose('api');
    document.body.focus();
    const press = (key: string) => fireEvent.keyDown(document.body, { key });
    press('j');
    press('j');
    press('j');
    press('j');
    expect(document.activeElement?.textContent).toBe('w-two');
    switchTo('~/personal');
    choose('blog');
    document.body.focus();
    press('j');
    press('j');
    press('j');
    expect(document.activeElement?.textContent).toBe('p-one');
  });

  it("offers the tab's directories alone in the New session dialog, starting with them, and keeps a typed one in the tab", () => {
    renderDashboard();
    switchTo('~/personal');
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    const dialog = screen.getByRole('dialog', { name: 'New session' });
    const directory = within(dialog).getByRole('combobox', { name: 'Directory' }) as HTMLSelectElement;
    expect([...directory.options].map((option) => option.textContent)).toEqual(['~/personal/blog', '~/personal', 'Another directory under a root…']);
    expect(within(dialog).getByText('Under ~/personal.')).toBeTruthy();

    fireEvent.change(directory, { target: { value: directory.options[2]!.value } });
    const path = within(dialog).getByRole('textbox', { name: 'Directory path' });
    fireEvent.change(path, { target: { value: at(WORK, 'api') } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start session' }));
    expect(within(dialog).getByText('Use a directory under ~/personal. ~/work has its own tab.')).toBeTruthy();
  });

  it("keeps a root with no sessions as a tab, with the usual empty state, naming its root", () => {
    renderDashboard(threeRoots());
    switchTo('~/scratch');
    expect(openTab()).toBe('~/scratch');
    expect(screen.getByText('No Claude Code sessions under ~/scratch')).toBeTruthy();
    expect(repoItems()).toEqual(['Needs you', 'All sessions0 sessions']);
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('keeps the page alerts and the header the whole page’s', () => {
    renderDashboard(twoRoots(sessions(), { source: { ok: false, error: 'made-up failure' } }));
    expect(screen.getByText("Couldn't list sessions")).toBeTruthy();
    switchTo('~/personal');
    expect(screen.getByText("Couldn't list sessions")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New session' })).toBeTruthy();
  });
});

describe("an inactive tab's badge", () => {
  it('counts its sessions that need you, and is in its name; the open tab has none', () => {
    renderDashboard();
    expect(badge('~/work')).toBeUndefined();
    expect(badge('~/personal')).toBe('1 needs you');
    expect(tab('~/personal').textContent).toBe('~/personal, 1 needs you');
    expect(tab('~/personal').querySelector('.badge')?.className).toBe('badge badge-attention');
  });

  it('appears and clears as sessions there need you and stop needing you', () => {
    const list = sessions();
    const { update } = renderDashboard(twoRoots(list));
    update(twoRoots({ ...list, p2: { ...list.p2, status: 'busy', waitingFor: undefined } as SessionSummary }));
    expect(badge('~/personal')).toBeUndefined();
    update(twoRoots({ ...list, p1: { ...list.p1, ...waiting }, p3: { ...list.p3, askedYou: { reason: 'question', excerpt: 'Made up?' } } }));
    expect(badge('~/personal')).toBe('3 need you');

    // Opened, it has none, and the tab left carries its own.
    switchTo('~/personal');
    expect(badge('~/personal')).toBeUndefined();
    expect(badge('~/work')).toBe('2 need you');
  });
});

describe("each tab's own place", () => {
  it('keeps its selection and open session, and switching pushes one history entry with them', async () => {
    const { history } = renderDashboard();
    choose('api');
    await open('w-two');
    switchTo('~/personal');
    expect(search(history)).toBe(`?view=all&root=${PERSONAL}`);
    expect(listHeading().textContent).toBe('All sessions');
    expect(view()).toBeUndefined();
    choose('blog');
    await open('p-one');

    const before = history.entries.length;
    switchTo('~/work');
    expect(history.entries.length).toBe(before + 1);
    expect(search(history)).toBe(`?repo=${at(WORK, 'api')}&root=${WORK}&session=${id(2)}`);
    expect(listHeading().textContent).toBe('api, git repo');
    expect(viewName()).toBe('w-two');

    switchTo('~/personal');
    expect(search(history)).toBe(`?repo=${at(PERSONAL, 'blog')}&root=${PERSONAL}&session=${id(11)}`);
    expect(viewName()).toBe('p-one');
  });

  it('remembers the selection chosen, and the open tab, in storage', () => {
    const storage = memory();
    renderDashboard(twoRoots(), { storage });
    switchTo('~/personal');
    expect(storage.values.get(ROOT_TAB_KEY)).toBe(PERSONAL);
    expect(storage.values.get(VIEW_STATE_KEY)).toBe(`view=all&root=${PERSONAL}`);
  });

  it('follows the back button to the tab it left, and forward again', async () => {
    const { history } = renderDashboard();
    await open('w-one');
    switchTo('~/personal');
    history.back();
    await settle();
    expect(openTab()).toBe('~/work');
    expect(viewName()).toBe('w-one');
    history.forward();
    await settle();
    expect(openTab()).toBe('~/personal');
    expect(view()).toBeUndefined();
  });

  it('keeps a tab’s session view, hidden, while another is open: its terminal stays attached', async () => {
    const { sockets } = renderDashboard();
    await open('w-job');
    fireEvent.click(within(view()!).getByRole('tab', { name: 'Terminal' }));
    await waitFor(() => expect(sockets.sockets).toHaveLength(1));
    const kept = view()!;

    switchTo('~/personal');
    await settle();
    expect(kept.isConnected).toBe(true);
    expect(kept.hidden).toBe(true);
    // A hidden view has no id, so the rows' aria-controls name only the one shown.
    expect(kept.id).toBe('');
    expect(sockets.last.closedByClient).toBe(false);
    expect(terminals[0]?.disposed).toBe(false);
    await open('p-one');
    expect(views()).toEqual([
      { name: 'w-job', hidden: true },
      { name: 'p-one', hidden: false },
    ]);

    switchTo('~/work');
    await settle();
    expect(view()).toBe(kept);
    expect(kept.hidden).toBe(false);
    expect(within(kept).getByRole('tab', { name: /Terminal/ }).getAttribute('aria-selected')).toBe('true');
    expect(sockets.sockets).toHaveLength(1);
    expect(sockets.last.closedByClient).toBe(false);
    expect(terminals).toHaveLength(1);
  });

  it('keeps a draft, and a send that is out, through a switch, with its result shown on return', async () => {
    const { server } = renderDashboard(twoRoots(), { search: `?view=all&root=${PERSONAL}` });
    await open('p-one');
    const box = () => within(view()!).getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(box(), { target: { value: 'A made-up draft, kept.' } });

    switchTo('~/work');
    switchTo('~/personal');
    expect(box().value).toBe('A made-up draft, kept.');

    fireEvent.click(within(view()!).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(server.relays).toHaveLength(1));
    switchTo('~/work');
    await act(async () => server.relays[0]!.answer('delivered'));
    switchTo('~/personal');
    await settle();
    expect(within(view()!).getByText(/^Delivered\./)).toBeTruthy();
    expect(box().value).toBe('');
  });

  it('opens a session started from a tab that has since been left in that tab, for when it’s back, not over the one open now', async () => {
    const list = sessions();
    const { update } = renderDashboard(twoRoots(list), { search: `?view=all&root=${PERSONAL}` });
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    const dialog = screen.getByRole('dialog', { name: 'New session' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'First prompt' }), { target: { value: 'A made-up first prompt.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start session' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New session' })).toBeNull());
    switchTo('~/work');
    await open('w-two');

    const started = session({ sessionId: id(19), name: 'p-new', kind: 'background', shortId: 'pt0099', state: 'working', status: undefined, cwd: at(PERSONAL, 'blog') });
    const next = twoRoots(list);
    next.groups[2] = { ...next.groups[2]!, sessions: [...next.groups[2]!.sessions, started] };
    update(next);
    await settle();
    expect(viewName()).toBe('w-two');
    switchTo('~/personal');
    expect(viewName()).toBe('p-new');
  });

  it("moves j from the conversation to the next session's conversation, past another tab's hidden view", async () => {
    renderDashboard();
    await open('w-one');
    switchTo('~/personal');
    await open('p-one');
    const body = view()!.querySelector<HTMLElement>('.session-view-body[role="tabpanel"]')!;
    body.focus();
    fireEvent.keyDown(body, { key: 'j' });
    await settle();
    expect(viewName()).toBe('p-three');
    expect(document.activeElement).toBe(view()!.querySelector('.session-view-body[role="tabpanel"]'));
    expect(views().find((each) => each.name === 'w-one')?.hidden).toBe(true);
  });

  it("ignores Escape in a hidden view: only the open tab's view closes", async () => {
    renderDashboard();
    await open('w-one');
    switchTo('~/personal');
    await open('p-one');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await settle();
    expect(view()).toBeUndefined();
    switchTo('~/work');
    expect(viewName()).toBe('w-one');
  });
});

describe('links and the URL', () => {
  it("opens the tab of a group in another root, with or without its root in the URL", () => {
    const first = renderDashboard(twoRoots(), { search: `?repo=${at(PERSONAL, 'blog')}&root=${PERSONAL}` });
    expect(openTab()).toBe('~/personal');
    expect(listHeading().textContent).toBe('blog, git repo');
    first.unmount();

    const { history } = renderDashboard(twoRoots(), { search: `?repo=${at(PERSONAL, 'blog')}` });
    expect(openTab()).toBe('~/personal');
    expect(search(history)).toBe(`?repo=${at(PERSONAL, 'blog')}&root=${PERSONAL}`);
  });

  it("opens the tab of a session in another root, at the group it's listed under", () => {
    const { history } = renderDashboard(twoRoots(), { search: `?session=${id(12)}` });
    expect(openTab()).toBe('~/personal');
    expect(listHeading().textContent).toBe('blog, git repo');
    expect(viewName()).toBe('p-two');
    expect(search(history)).toBe(`?repo=${at(PERSONAL, 'blog')}&root=${PERSONAL}&session=${id(12)}`);
  });

  it('gives a view the tab its URL names, and one without a root, or with one pitwall doesn’t watch, the first', () => {
    const one = renderDashboard(twoRoots(), { search: `?view=needs-you&root=${PERSONAL}` });
    expect(openTab()).toBe('~/personal');
    expect(rows()).toEqual(['p-two']);
    one.unmount();
    const two = renderDashboard(twoRoots(), { search: '?view=needs-you' });
    expect(openTab()).toBe('~/work');
    expect(search(two.history)).toBe(`?view=needs-you&root=${WORK}`);
    two.unmount();
    const three = renderDashboard(twoRoots(), { search: '?view=all&root=/Users/example/gone' });
    expect(openTab()).toBe('~/work');
    expect(search(three.history)).toBe(`?view=all&root=${WORK}`);
  });

  it("links each repo list item, the views included, with the tab's root", () => {
    renderDashboard(twoRoots(), { search: `?view=all&root=${PERSONAL}` });
    expect(repoItem('Needs you').getAttribute('href')).toBe(`?view=needs-you&root=${PERSONAL}`);
    expect(repoItem('blog').getAttribute('href')).toBe(`?repo=${at(PERSONAL, 'blog')}&root=${PERSONAL}`);
  });
});

describe('the stored tab', () => {
  const thrower: StorageSource = () => ({
    getItem: () => {
      throw new Error('made-up: blocked');
    },
    setItem: () => {
      throw new Error('made-up: blocked');
    },
  });

  it('opens the stored tab for a URL with no selection, holding the root’s path alone', () => {
    const storage = memory({ [ROOT_TAB_KEY]: PERSONAL });
    const { history } = renderDashboard(twoRoots(), { storage });
    expect(openTab()).toBe('~/personal');
    expect(search(history)).toBe(`?view=all&root=${PERSONAL}`);
    switchTo('~/work');
    expect(storage.values.get(ROOT_TAB_KEY)).toBe(WORK);
  });

  it('lets a URL with a selection win over the stored tab', () => {
    renderDashboard(twoRoots(), { storage: memory({ [ROOT_TAB_KEY]: PERSONAL }), search: `?view=all&root=${WORK}` });
    expect(openTab()).toBe('~/work');
  });

  it('opens the first tab when storage is missing, throws, or holds a root pitwall no longer watches, and switching still works', () => {
    for (const storage of [() => null, thrower, memory({ [ROOT_TAB_KEY]: '/Users/example/gone' }), memory({ [ROOT_TAB_KEY]: '' })] as StorageSource[]) {
      const shown = renderDashboard(twoRoots(), { storage });
      expect(openTab()).toBe('~/work');
      expect(() => switchTo('~/personal')).not.toThrow();
      expect(openTab()).toBe('~/personal');
      shown.unmount();
    }
  });
});

describe('the keyboard', () => {
  it('moves focus along the tabs with ← and →, wrapping, and Home and End, without opening one', () => {
    renderDashboard(threeRoots());
    tab('~/work').focus();
    fireEvent.keyDown(tab('~/work'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tab('~/personal'));
    fireEvent.keyDown(tab('~/personal'), { key: 'End' });
    expect(document.activeElement).toBe(tab('~/scratch'));
    fireEvent.keyDown(tab('~/scratch'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tab('~/work'));
    fireEvent.keyDown(tab('~/work'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(tab('~/scratch'));
    fireEvent.keyDown(tab('~/scratch'), { key: 'Home' });
    expect(document.activeElement).toBe(tab('~/work'));
    // Alt + ← is the browser's back, not a tab key.
    fireEvent.keyDown(tab('~/work'), { key: 'ArrowLeft', altKey: true });
    expect(document.activeElement).toBe(tab('~/work'));
    expect(openTab()).toBe('~/work');
  });

  it('opens the focused tab with Enter or Space, as its click, and leaves focus on it', () => {
    renderDashboard();
    tab('~/personal').focus();
    // A button's Enter and Space are its click.
    fireEvent.click(tab('~/personal'));
    expect(openTab()).toBe('~/personal');
    expect(document.activeElement).toBe(tab('~/personal'));
    expect(tab('~/personal').tabIndex).toBe(0);
    expect(tab('~/work').tabIndex).toBe(-1);
  });

  it('puts focus on the open tab when the back button switches tabs from inside the view it hides', async () => {
    const { history } = renderDashboard();
    switchTo('~/personal');
    await open('p-one');
    switchTo('~/work');
    // Back to ~/personal's place, its view open again, then back from there to ~/work's.
    switchTo('~/personal');
    within(view()!).getByRole('textbox').focus();
    history.back();
    await settle();
    expect(openTab()).toBe('~/work');
    expect(document.activeElement).toBe(tab('~/work'));
  });

  it('keeps the shortcuts as they were: / focuses the open tab’s filter, and n opens the dialog for its root', () => {
    renderDashboard(twoRoots(), { search: `?view=all&root=${PERSONAL}` });
    document.body.focus();
    fireEvent.keyDown(document.body, { key: '/' });
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Filter sessions' }));
    document.body.focus();
    fireEvent.keyDown(document.body, { key: 'n' });
    expect(within(screen.getByRole('dialog', { name: 'New session' })).getByText('Under ~/personal.')).toBeTruthy();
  });
});

describe('one root inside another', () => {
  // The index puts a session under the longest root that holds it (src/index/roots.ts, matchRoot), so
  // each group's root says which tab it's in; the outer root's tab never lists the inner one's.
  const OUTER = '/Users/example/code';
  const INNER = '/Users/example/code/personal';
  const nested = () =>
    snapshot(
      [
        group({ key: at(OUTER, 'app'), label: 'app', root: OUTER, sessions: [session({ name: 'outer-app', cwd: at(OUTER, 'app') })] }),
        group({ key: at(INNER, 'blog'), label: 'blog', root: INNER, sessions: [session({ name: 'inner-blog', cwd: at(INNER, 'blog'), ...waiting })] }),
      ],
      { roots: [OUTER, INNER] },
    );

  it("lists the inner root's sessions in its own tab alone, and badges it", () => {
    renderDashboard(nested());
    expect(labels()).toEqual(['~/code', '~/code/personal']);
    expect(rows()).toEqual(['outer-app']);
    expect(repoItems()).toEqual(['Needs you', 'All sessions1 session', 'app, git repo1 session']);
    expect(badge('~/code/personal')).toBe('1 needs you');
    switchTo('~/code/personal');
    expect(rows()).toEqual(['inner-blog']);
  });

  it("keeps a typed directory under the inner root out of the outer root's New session dialog", () => {
    renderDashboard(nested());
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    const dialog = screen.getByRole('dialog', { name: 'New session' });
    const directory = within(dialog).getByRole('combobox', { name: 'Directory' }) as HTMLSelectElement;
    expect([...directory.options].map((option) => option.textContent)).toEqual(['~/code/app', '~/code', 'Another directory under a root…']);
    fireEvent.change(directory, { target: { value: directory.options[2]!.value } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Directory path' }), { target: { value: at(INNER, 'new') } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start session' }));
    expect(within(dialog).getByText('Use a directory under ~/code. ~/code/personal has its own tab.')).toBeTruthy();
  });
});
