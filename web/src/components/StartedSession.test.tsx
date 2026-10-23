// A session started from New session is selected once it's listed (W63): its group under each Group
// sessions by mode, the root's own included, its view, and with root tabs its tab; from Needs you and
// from another tab; in one pushed history entry. Not over what you're in the middle of, a draft, an
// open confirmation, typing in the columns, or a draft in the view the session would replace in its
// tab: then a toast says it's listed, with Open, in place of the one that said it started. And where
// focus goes. Made-up sessions only, and fake sockets: nothing here reaches a session.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationPage, IndexSnapshot, SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import { AttachContext, type AttachEnv } from '../attach.js';
import { GROUP_BY_KEY, GROUP_BY_MODES, type GroupBy } from '../groupBy.js';
import type { StorageSource } from '../groupState.js';
import { fakeSockets, group, minutesAgo, NOW, session, snapshot } from '../test/fixtures.js';
import { fakeHistory } from '../test/history.js';
import { toastMessages, toastSaying } from '../test/toasts.js';
import { Dashboard, listedText, OPEN_LISTED, startedText } from './Dashboard.js';
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
const OTHER = '/Users/example/oss';
const at = (name: string, root = ROOT) => `${root}/${name}`;
const id = (n: number) => `00000000-0000-4000-8000-0000000063${String(n).padStart(2, '0')}`;
/** What the fake server says it started. */
const STARTED = { shortId: 'pt6399', name: 'new-one' } as const;
const NEW_ID = id(99);

/**
 * One root: api, with api-one and a background job; web, with web-one needing you; and from-root,
 * started in the root itself, which changed api, so Main repo lists it under api and Every repo it
 * worked in leaves it out of the root's own group. Only Where it started lists ~/code before a session
 * is started there.
 */
function snap(started?: { in: 'web' | 'root'; session: SessionSummary }): IndexSnapshot {
  const api1 = session({ sessionId: id(1), name: 'api-one', cwd: at('api'), lastActivityAt: minutesAgo(1) });
  const job = session({ sessionId: id(4), name: 'api-job', kind: 'background', shortId: 'pt6304', state: 'working', status: undefined, cwd: at('api'), lastActivityAt: minutesAgo(4) });
  const web1 = session({ sessionId: id(2), name: 'web-one', cwd: at('web'), status: 'waiting', waitingFor: 'permission prompt', lastActivityAt: minutesAgo(2) });
  const fromRoot = session({
    sessionId: id(3),
    name: 'from-root',
    cwd: ROOT,
    workedIn: [{ key: at('api'), label: 'api', root: ROOT, calls: 40, changes: 5, lastAt: minutesAgo(3) }],
    lastActivityAt: minutesAgo(3),
  });
  return snapshot(
    [
      group({ key: ROOT, label: 'code', kind: 'directory', root: ROOT, sessions: [fromRoot, ...(started?.in === 'root' ? [started.session] : [])] }),
      group({ key: at('api'), label: 'api', root: ROOT, sessions: [api1, job] }),
      group({ key: at('web'), label: 'web', root: ROOT, sessions: [web1, ...(started?.in === 'web' ? [started.session] : [])] }),
    ],
    { roots: [ROOT] },
  );
}

/** The session the fake server started, as the index lists it, in web or in the root itself. */
function startedIn(where: 'web' | 'root', root = ROOT): SessionSummary {
  return session({
    sessionId: NEW_ID,
    name: STARTED.name,
    kind: 'background',
    shortId: STARTED.shortId,
    state: 'working',
    status: undefined,
    cwd: where === 'root' ? root : at('web', root),
    lastActivityAt: minutesAgo(0),
  });
}

/** Two roots: this file's one root, and ~/oss with a blog. */
function twoRoots(started?: SessionSummary): IndexSnapshot {
  const one = snap(started ? { in: 'web', session: started } : undefined);
  const blog = session({ sessionId: id(11), name: 'blog-one', cwd: at('blog', OTHER), lastActivityAt: minutesAgo(1) });
  return { ...one, roots: [ROOT, OTHER], groups: [...one.groups, group({ key: at('blog', OTHER), label: 'blog', root: OTHER, sessions: [blog] })] };
}

function memory(entries: Record<string, string> = {}): StorageSource {
  const values = new Map(Object.entries(entries));
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
  return () => storage;
}

/** Starts STARTED on POST /api/sessions; refuses every other POST; answers every GET with a page of one entry. */
function fakeServer() {
  return vi.fn<FetchLike>(async (url, init) => {
    if (init.method === 'POST' && url === '/api/sessions') return new Response(JSON.stringify({ ok: true, ...STARTED }), { status: 201 });
    if (init.method === 'POST') return new Response(JSON.stringify({ ok: false, error: 'not in this test' }), { status: 409 });
    const sessionId = decodeURIComponent(url.split('/')[3] ?? '');
    const page: ConversationPage = { sessionId, entries: [{ kind: 'assistant', text: `made-up reply from ${sessionId.slice(-2)}` }] };
    return new Response(JSON.stringify(page), { status: 200 });
  });
}

function renderDashboard(first: IndexSnapshot = snap(), options: { search?: string; groupBy?: GroupBy } = {}) {
  const history = fakeHistory(options.search ?? '?view=all');
  const api = createApiClient({ apiKey: 'k'.repeat(43), fetch: fakeServer() });
  const attach: AttachEnv = { token: 'pitwall-test-token-0123456789abcdefghijklmnop', createSocket: fakeSockets().factory, host: '127.0.0.1:4517' };
  const storage = memory(options.groupBy ? { [GROUP_BY_KEY]: options.groupBy } : {});
  const ui = (s: IndexSnapshot) => (
    <ApiContext.Provider value={api}>
      <AttachContext.Provider value={attach}>
        <Dashboard view={{ state: 'live', snapshot: s }} navigation={history.navigation} storage={storage} />
      </AttachContext.Provider>
    </ApiContext.Provider>
  );
  const result = render(ui(first));
  const update = async (next: IndexSnapshot) => {
    result.rerender(ui(next));
    await settle();
  };
  return { ...result, history, update };
}

const settle = () => act(async () => {});

/** New session, from the header's button, which the dialog gives focus back to, with a made-up first prompt. */
async function startSession(from: HTMLElement = screen.getByRole('button', { name: 'New session' })) {
  from.focus();
  if (from.matches('header button')) fireEvent.click(from);
  else fireEvent.keyDown(from, { key: 'n' });
  const dialog = screen.getByRole('dialog', { name: 'New session' });
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'First prompt' }), { target: { value: 'A made-up first prompt.' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Start session' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New session' })).toBeNull());
}

const repoList = () => screen.getByRole('navigation', { name: 'Repos' });
const repoLabels = () => [...repoList().querySelectorAll('a[data-repo-item] .repo-item-label')].map((label) => label.textContent);
/** The repo list's selected item, by its label. */
const selectedRepo = () => repoList().querySelector('a[aria-current="page"] .repo-item-label')?.textContent;
function repoItem(label: string): HTMLAnchorElement {
  const found = [...repoList().querySelectorAll<HTMLAnchorElement>('a[data-repo-item]')].find((link) => link.querySelector('.repo-item-label')?.textContent === label);
  if (!found) throw new Error(`no repo list item ${label}`);
  return found;
}
const rowButton = (name: string) => within(screen.getByRole('main')).getByRole('button', { name });
/** The session list's row marked as the open one. */
const openRow = () => document.querySelector('.session-list [data-open-session][aria-current="true"]')?.textContent;
const view = () => document.getElementById('session-view') ?? undefined;
const viewName = () => view()?.querySelector('.session-view-name')?.textContent;
const heading = () => view()?.querySelector('h2');
const openTab = () => document.querySelector('.root-tab[aria-selected="true"] .root-tab-label')?.textContent;
const tab = (label: string) => [...document.querySelectorAll<HTMLElement>('.root-tab')].find((each) => each.querySelector('.root-tab-label')?.textContent === label)!;
const messageBox = () => within(view()!).getByRole('textbox') as HTMLTextAreaElement;
const listedToast = () => toastSaying(listedText(STARTED.name));

async function open(name: string) {
  fireEvent.click(rowButton(name));
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
});

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
});

describe('a session started from New session, once it is listed', () => {
  describe.each(GROUP_BY_MODES)('grouped by %s', (mode) => {
    it('selects the repo it started in, opens its view, and marks its row as the open one', async () => {
      const { update, history } = renderDashboard(snap(), { groupBy: mode });
      await startSession();
      expect(toastMessages()).toEqual([startedText(STARTED.name)]);
      await update(snap({ in: 'web', session: startedIn('web') }));

      expect(selectedRepo()).toBe('web');
      expect(viewName()).toBe(STARTED.name);
      expect(openRow()).toBe(STARTED.name);
      expect(history.location.search).toBe(`?repo=${at('web')}&session=${NEW_ID}`);
    });

    it("selects the root's own group for one started in the root itself, whether or not the repo list had it before", async () => {
      const { update, history } = renderDashboard(snap(), { groupBy: mode });
      // Only Where it started lists from-root under ~/code; the others list it under api.
      expect(repoLabels().includes('~/code')).toBe(mode === 'where-started');
      await startSession();
      await update(snap({ in: 'root', session: startedIn('root') }));

      expect(selectedRepo()).toBe('~/code');
      expect(viewName()).toBe(STARTED.name);
      expect(openRow()).toBe(STARTED.name);
      expect(history.location.search).toBe(`?repo=${ROOT}&session=${NEW_ID}`);
    });
  });

  it('selects its group from Needs you, which doesn’t list it', async () => {
    const { update, history } = renderDashboard(snap(), { search: '?view=needs-you' });
    expect(selectedRepo()).toBe('Needs you');
    await startSession();
    await update(snap({ in: 'web', session: startedIn('web') }));
    expect(selectedRepo()).toBe('web');
    expect(openRow()).toBe(STARTED.name);
    expect(history.location.search).toBe(`?repo=${at('web')}&session=${NEW_ID}`);
  });

  it('selects its group from another group, closing nothing but the view it replaces', async () => {
    const { update } = renderDashboard();
    fireEvent.click(repoItem('api'));
    await open('api-one');
    await startSession();
    await update(snap({ in: 'web', session: startedIn('web') }));
    expect(selectedRepo()).toBe('web');
    expect(viewName()).toBe(STARTED.name);
  });

  it('pushes one history entry, as opening a row does, so back goes to where you were', async () => {
    const { update, history } = renderDashboard();
    await open('api-one');
    const before = history.entries.length;
    await startSession();
    await update(snap({ in: 'web', session: startedIn('web') }));
    expect(history.entries.length).toBe(before + 1);

    history.back();
    await settle();
    expect(selectedRepo()).toBe('All sessions');
    expect(viewName()).toBe('api-one');
    expect(history.location.search).toBe(`?view=all&session=${id(1)}`);
  });

  it("switches to its root tab from another, and says so in the URL, keeping the tab you left as it was", async () => {
    const { update, history } = renderDashboard(twoRoots(), { search: `?view=all&root=${ROOT}` });
    await startSession();
    fireEvent.click(tab('~/oss'));
    await open('blog-one');
    expect(openTab()).toBe('~/oss');
    await update(twoRoots(startedIn('web')));

    expect(openTab()).toBe('~/code');
    expect(selectedRepo()).toBe('web');
    expect(viewName()).toBe(STARTED.name);
    expect(history.location.search).toBe(`?repo=${at('web')}&root=${ROOT}&session=${NEW_ID}`);
    fireEvent.click(tab('~/oss'));
    await settle();
    expect(viewName()).toBe('blog-one');
  });
});

describe('where focus goes', () => {
  it('stays on New session, where the dialog gave it back', async () => {
    const { update } = renderDashboard();
    await startSession();
    const button = screen.getByRole('button', { name: 'New session' });
    expect(document.activeElement).toBe(button);
    await update(snap({ in: 'web', session: startedIn('web') }));
    expect(viewName()).toBe(STARTED.name);
    expect(document.activeElement).toBe(button);
  });

  it("goes to the view's heading when the switch takes away the row that had it", async () => {
    const { update } = renderDashboard();
    fireEvent.click(repoItem('api'));
    // `n` on a row: the dialog gives focus back to the row, which web's list doesn't have.
    await startSession(rowButton('api-one'));
    expect(document.activeElement).toBe(rowButton('api-one'));
    await update(snap({ in: 'web', session: startedIn('web') }));
    expect(selectedRepo()).toBe('web');
    expect(document.activeElement).toBe(heading());
  });

  it("goes to the view's heading below 1,200 px when the view comes to cover the row that had it", async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    const { update } = renderDashboard();
    await startSession(rowButton('web-one'));
    await update(snap({ in: 'web', session: startedIn('web') }));
    expect(screen.getByRole('dialog', { name: STARTED.name })).toBeTruthy();
    expect(document.activeElement).toBe(heading());
  });
});

describe("not over what you're in the middle of", () => {
  it('keeps the open view with a draft, and says the session is listed, with Open, in place of the toast that said it started', async () => {
    const { update, history } = renderDashboard();
    await open('api-one');
    fireEvent.change(messageBox(), { target: { value: 'A made-up draft, kept.' } });
    await startSession();
    await update(snap({ in: 'web', session: startedIn('web') }));

    expect(selectedRepo()).toBe('All sessions');
    expect(viewName()).toBe('api-one');
    expect(messageBox().value).toBe('A made-up draft, kept.');
    expect(toastMessages()).toEqual([listedText(STARTED.name)]);
    expect(listedText(STARTED.name)).toBe("new-one is listed now. It didn't open, so you keep your place.");
    expect(history.location.search).toBe(`?view=all&session=${id(1)}`);

    // Open does what the switch would have done, and focus goes to the view's heading, as from a row.
    fireEvent.click(within(listedToast()).getByRole('button', { name: OPEN_LISTED }));
    await settle();
    expect(selectedRepo()).toBe('web');
    expect(viewName()).toBe(STARTED.name);
    expect(document.activeElement).toBe(heading());
    expect(toastMessages()).toEqual([]);
    expect(history.location.search).toBe(`?repo=${at('web')}&session=${NEW_ID}`);

    // The draft is the tab's (W44): back to its view, it's there.
    history.back();
    await settle();
    expect(viewName()).toBe('api-one');
    expect(messageBox().value).toBe('A made-up draft, kept.');
  });

  it('keeps the open view while it asks to stop its session', async () => {
    const { update } = renderDashboard();
    await open('api-job');
    fireEvent.click(within(view()!).getByRole('button', { name: 'Session actions' }));
    fireEvent.click(within(view()!).getByRole('menuitem', { name: 'Stop session' }));
    expect(within(view()!).getByRole('button', { name: 'Cancel' })).toBeTruthy();
    await startSession();
    await update(snap({ in: 'web', session: startedIn('web') }));
    expect(viewName()).toBe('api-job');
    expect(toastMessages()).toEqual([listedText(STARTED.name)]);

    // Once the question is answered, a later session isn't held back by it.
    fireEvent.click(within(view()!).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(listedToast()).getByRole('button', { name: OPEN_LISTED }));
    await settle();
    expect(viewName()).toBe(STARTED.name);
  });

  it('keeps your place while you type in the filter', async () => {
    const { update, history } = renderDashboard();
    await startSession();
    const field = screen.getByRole('searchbox', { name: 'Filter sessions' }) as HTMLInputElement;
    field.focus();
    fireEvent.change(field, { target: { value: 'one' } });
    await update(snap({ in: 'web', session: startedIn('web') }));
    expect(selectedRepo()).toBe('All sessions');
    expect(viewName()).toBeUndefined();
    expect(document.activeElement).toBe(field);
    expect(history.location.search).toBe('?view=all');
    expect(toastMessages()).toEqual([listedText(STARTED.name)]);
  });

  it("keeps the view open in the session's own tab when it has a draft, which the session would replace", async () => {
    const { update } = renderDashboard(twoRoots(), { search: `?view=all&root=${ROOT}` });
    await open('api-one');
    fireEvent.change(messageBox(), { target: { value: 'A made-up draft, kept.' } });
    await startSession();
    fireEvent.click(tab('~/oss'));
    await settle();
    await update(twoRoots(startedIn('web')));
    expect(openTab()).toBe('~/oss');
    expect(toastMessages()).toEqual([listedText(STARTED.name)]);

    fireEvent.click(within(listedToast()).getByRole('button', { name: OPEN_LISTED }));
    await settle();
    expect(openTab()).toBe('~/code');
    expect(selectedRepo()).toBe('web');
    expect(viewName()).toBe(STARTED.name);
  });

  it('takes the toast away once the session is opened another way, from its row', async () => {
    const { update } = renderDashboard();
    await open('api-one');
    fireEvent.change(messageBox(), { target: { value: 'A made-up draft, kept.' } });
    await startSession();
    await update(snap({ in: 'web', session: startedIn('web') }));
    expect(toastMessages()).toEqual([listedText(STARTED.name)]);
    await open(STARTED.name);
    expect(viewName()).toBe(STARTED.name);
    expect(toastMessages()).toEqual([]);
  });
});
