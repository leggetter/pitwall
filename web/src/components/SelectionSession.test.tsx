// Selecting a repo or directory with a session open (W139, Phil's option B, 2026-11-04): the session
// stays open only if the group lists it, otherwise the view closes to "Select a session", in the one
// history entry the selection pushes. Listing is what counts, so a session the filter, a collapsed
// Finished section or Show older hides stays; in Every repo it worked in, any group that lists it keeps
// it. Views keep it as before, and a URL, the back button and a root tab show what they name.
// Made-up sessions and paths only.

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationPage, IndexSnapshot, SessionSummary, WorkedIn } from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import { BACKGROUND_TAB_KEY } from '../backgroundTab.js';
import { GROUP_BY_KEY, type GroupBy } from '../groupBy.js';
import type { StorageSource } from '../groupState.js';
import { group, minutesAgo, NOW, session, snapshot, withoutSubagents } from '../test/fixtures.js';
import { fakeHistory } from '../test/history.js';
import { Dashboard } from './Dashboard.js';

const ROOT = '/Users/example/code';
const APP = `${ROOT}/demo-app`;
const NOTES = `${ROOT}/notes`;
const id = (n: number) => `00000000-0000-4000-8000-0000001390${String(n).padStart(2, '0')}`;
const A = id(1);
const B = id(2);
const DONE = id(3);
const OLD = id(4);
const N = id(5);

/** demo-app: A, B, a finished one and one that ended 30 days ago, which Show older hides; notes: N. */
function oneRoot(list: { app?: SessionSummary[]; notes?: SessionSummary[] } = {}): IndexSnapshot {
  const app = list.app ?? [
    session({ sessionId: A, name: 'demo-a', cwd: APP, lastActivityAt: minutesAgo(1) }),
    session({ sessionId: B, name: 'demo-b', cwd: APP, lastActivityAt: minutesAgo(2) }),
    session({ sessionId: DONE, name: 'demo-done', cwd: APP, kind: 'background', shortId: 'pt0003', state: 'done', alive: false, pid: undefined, finished: true, status: undefined }),
    session({ sessionId: OLD, name: 'demo-old', cwd: APP, ended: true, finished: true, alive: false, pid: undefined, status: undefined, lastActivityAt: minutesAgo(60 * 24 * 30) }),
  ];
  const notes = list.notes ?? [session({ sessionId: N, name: 'notes-tidy', cwd: NOTES, lastActivityAt: minutesAgo(3) })];
  return snapshot([group({ key: APP, label: 'demo-app', sessions: app }), group({ key: NOTES, label: 'notes', kind: 'directory', sessions: notes })]);
}

const WORK = '/Users/example/work';
const PERSONAL = '/Users/example/personal';
const at = (root: string, name: string) => `${root}/${name}`;
const worked = (root: string, name: string, changes: number, calls: number): WorkedIn => ({ key: at(root, name), label: name, root, calls, changes, lastAt: minutesAgo(1) });
const CROSS = id(11);
const IN_API = id(12);
const IN_WEB = id(13);
const IN_BLOG = id(14);
const IN_DOCS = id(15);

/**
 * Two roots, each session where it started (W39). `cross`, started in ~/work itself, changed blog
 * (under ~/personal) most, then api and web: Main repo lists it under blog alone, and Every repo it
 * worked in under blog, api and web, never docs.
 */
function twoRoots(): IndexSnapshot {
  const cross = session({ sessionId: CROSS, name: 'cross', cwd: WORK, lastActivityAt: minutesAgo(1), workedIn: [worked(PERSONAL, 'blog', 10, 50), worked(WORK, 'api', 2, 60), worked(WORK, 'web', 1, 5)] });
  const inApi = session({ sessionId: IN_API, name: 'in-api', cwd: at(WORK, 'api'), lastActivityAt: minutesAgo(2) });
  const inWeb = session({ sessionId: IN_WEB, name: 'in-web', cwd: at(WORK, 'web'), lastActivityAt: minutesAgo(3) });
  const inDocs = session({ sessionId: IN_DOCS, name: 'in-docs', cwd: at(WORK, 'docs'), lastActivityAt: minutesAgo(5) });
  const inBlog = session({ sessionId: IN_BLOG, name: 'in-blog', cwd: at(PERSONAL, 'blog'), lastActivityAt: minutesAgo(4) });
  return snapshot(
    [
      group({ key: WORK, label: 'work', kind: 'directory', root: WORK, sessions: [cross] }),
      group({ key: at(WORK, 'api'), label: 'api', root: WORK, sessions: [inApi] }),
      group({ key: at(WORK, 'web'), label: 'web', root: WORK, sessions: [inWeb] }),
      group({ key: at(WORK, 'docs'), label: 'docs', root: WORK, sessions: [inDocs] }),
      group({ key: at(PERSONAL, 'blog'), label: 'blog', root: PERSONAL, sessions: [inBlog] }),
    ],
    { roots: [WORK, PERSONAL] },
  );
}

function memory(entries: Record<string, string> = {}): StorageSource & { values: Map<string, string> } {
  const values = new Map(Object.entries(entries));
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
  return Object.assign(() => storage, { values });
}

/** Every GET is a conversation page of one entry; every POST is refused, and recorded. */
function fakeServer() {
  return vi.fn<FetchLike>(async (url, init) => {
    if (init.method === 'POST') return new Response(JSON.stringify({ ok: false, error: 'not in this test' }), { status: 409 });
    const sessionId = decodeURIComponent(url.split('/')[3] ?? '');
    const page: ConversationPage = { sessionId, entries: [{ kind: 'assistant', text: 'a made-up reply' }] };
    return new Response(JSON.stringify(page), { status: 200 });
  });
}

function renderDashboard(first: IndexSnapshot, options: { search?: string; mode?: GroupBy } = {}) {
  const history = fakeHistory(options.search ?? '?view=all');
  const fetch = fakeServer();
  const api = createApiClient({ apiKey: 'k'.repeat(43), fetch: withoutSubagents(fetch) });
  // Conversation first, so no running background session's view attaches.
  const storage = memory({ [BACKGROUND_TAB_KEY]: 'conversation', ...(options.mode ? { [GROUP_BY_KEY]: options.mode } : {}) });
  const ui = (s: IndexSnapshot) => (
    <ApiContext.Provider value={api}>
      <Dashboard view={{ state: 'live', snapshot: s }} navigation={history.navigation} storage={storage} />
    </ApiContext.Provider>
  );
  const result = render(ui(first));
  return { ...result, history, fetch, update: (next: IndexSnapshot) => result.rerender(ui(next)) };
}

const settle = () => act(async () => {});
function setWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

const main = () => screen.getByRole('main');
const repoList = () => screen.getByRole('navigation', { name: 'Repos' });
const repoItem = (label: string) => {
  const item = [...repoList().querySelectorAll<HTMLAnchorElement>('a[data-repo-item]')].find((link) => link.querySelector('.repo-item-label')?.textContent === label);
  if (!item) throw new Error(`no repo list item ${label}`);
  return item;
};
async function choose(label: string) {
  fireEvent.click(repoItem(label));
  await settle();
}
async function open(name: string) {
  fireEvent.click(within(main()).getByRole('button', { name }));
  await settle();
}
const view = () => (document.getElementById('session-view') as HTMLElement | null) ?? undefined;
const viewName = () => {
  const shown = view();
  return shown ? document.getElementById(shown.getAttribute('aria-labelledby')!)?.querySelector('.session-view-name')?.textContent : undefined;
};
/** The third column's text with nothing open. */
const emptyColumn = () => screen.getByRole('region', { name: 'Session' }).textContent;
const tab = (label: string) => {
  const found = screen.getAllByRole('tab').find((candidate) => candidate.classList.contains('root-tab') && candidate.textContent?.includes(label));
  if (!found) throw new Error(`no tab ${label}`);
  return found;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  setWidth(1300);
});

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
});

describe('selecting a group with a session open (W139)', () => {
  it('closes a session the group does not list, in the one pushed entry, to "Select a session"', async () => {
    const { history } = renderDashboard(oneRoot());
    await open('demo-a');
    await choose('notes');
    expect(history.entries).toEqual(['?view=all', `?view=all&session=${A}`, `?repo=${NOTES}`]);
    expect(view()).toBeUndefined();
    expect(emptyColumn()).toBe('Select a sessionIts conversation, terminal and actions open here.');
  });

  it('keeps a session the group lists, adding the selection to its entry', async () => {
    const { history } = renderDashboard(oneRoot());
    await open('demo-a');
    await choose('demo-app');
    expect(history.location.search).toBe(`?repo=${APP}&session=${A}`);
    expect(viewName()).toBe('demo-a');
  });

  it('keeps it when the filter hides it in the group', async () => {
    const { history } = renderDashboard(oneRoot());
    await open('demo-a');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'demo-b' } });
    await choose('demo-app');
    expect(within(main()).queryByRole('button', { name: 'demo-a' })).toBeNull();
    expect(history.location.search).toBe(`?repo=${APP}&session=${A}`);
    expect(viewName()).toBe('demo-a');
  });

  it("keeps a finished one, in the group's collapsed Finished section", async () => {
    const { history } = renderDashboard(oneRoot(), { search: `?view=all&session=${DONE}` });
    await settle();
    await choose('demo-app');
    expect(within(main()).queryByRole('button', { name: 'demo-done' })).toBeNull();
    expect(history.location.search).toBe(`?repo=${APP}&session=${DONE}`);
    expect(viewName()).toBe('demo-done');
  });

  it('keeps an older ended one that Show older hides, and closes it for another group', async () => {
    const { history } = renderDashboard(oneRoot(), { search: `?view=all&session=${OLD}` });
    await settle();
    expect(viewName()).toBe('demo-old');
    await choose('demo-app');
    expect(history.location.search).toBe(`?repo=${APP}&session=${OLD}`);
    expect(viewName()).toBe('demo-old');
    await choose('notes');
    expect(view()).toBeUndefined();
  });

  it('keeps a starred one in its group, and Starred, as a view, keeps any', async () => {
    const { history } = renderDashboard(oneRoot());
    await open('demo-a');
    fireEvent.click(within(main()).getByRole('button', { name: 'Star demo-a' }));
    await choose('demo-app');
    expect(viewName()).toBe('demo-a');
    await open('demo-b');
    await choose('Starred');
    expect(history.location.search).toBe(`?view=starred&session=${B}`);
    expect(viewName()).toBe('demo-b');
  });

  it('views keep the open session as before: Needs you and All sessions', async () => {
    const { history } = renderDashboard(oneRoot(), { search: `?repo=${NOTES}` });
    await open('notes-tidy');
    await choose('Needs you');
    expect(history.location.search).toBe(`?view=needs-you&session=${N}`);
    await choose('All sessions');
    expect(history.location.search).toBe(`?view=all&session=${N}`);
    expect(viewName()).toBe('notes-tidy');
  });

  it('back returns to the session and the group it was under; forward closes it again', async () => {
    const { history } = renderDashboard(oneRoot(), { search: `?repo=${APP}` });
    await open('demo-a');
    await choose('notes');
    expect(view()).toBeUndefined();
    history.back();
    await settle();
    expect(history.location.search).toBe(`?repo=${APP}&session=${A}`);
    expect(viewName()).toBe('demo-a');
    expect(repoItem('demo-app').getAttribute('aria-current')).toBe('page');
    history.forward();
    await settle();
    expect(view()).toBeUndefined();
    expect(repoItem('notes').getAttribute('aria-current')).toBe('page');
  });

  it('a deep link to a group and a session it does not list shows both, as the URL says, until a group is chosen', async () => {
    const { history } = renderDashboard(oneRoot(), { search: `?repo=${NOTES}&session=${A}` });
    await settle();
    expect(history.entries).toEqual([`?repo=${NOTES}&session=${A}`]);
    expect(viewName()).toBe('demo-a');
    // Choosing the group it's on applies the rule too: one entry, without the session.
    await choose('notes');
    expect(history.entries).toEqual([`?repo=${NOTES}&session=${A}`, `?repo=${NOTES}`]);
    expect(view()).toBeUndefined();
  });

  it('a session that leaves the list on its own stays open; choosing its group then closes it', async () => {
    const { update, history } = renderDashboard(oneRoot(), { search: `?repo=${APP}` });
    await open('demo-a');
    update(oneRoot({ app: [session({ sessionId: B, name: 'demo-b', cwd: APP })] }));
    await settle();
    expect(viewName()).toBe('demo-a');
    expect(within(view()!).getByText('This session is no longer listed, so this is what it showed last.')).toBeTruthy();
    expect(history.location.search).toBe(`?repo=${APP}&session=${A}`);
    await choose('demo-app');
    expect(view()).toBeUndefined();
  });

  it('from the drawer below 900 px, too', async () => {
    setWidth(800);
    const { history } = renderDashboard(oneRoot(), { search: `?repo=${APP}&session=${A}` });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Repos' }));
    const drawer = screen.getByRole('dialog', { name: 'Repos' });
    const notes = [...drawer.querySelectorAll<HTMLAnchorElement>('a[data-repo-item]')].find((link) => link.querySelector('.repo-item-label')?.textContent === 'notes')!;
    fireEvent.click(notes);
    await settle();
    expect(history.location.search).toBe(`?repo=${NOTES}`);
    expect(view()).toBeUndefined();
  });
});

describe('with groupings and root tabs (W139)', () => {
  it('Every repo it worked in: any group that lists the session keeps it, not only its home group', async () => {
    const { history } = renderDashboard(twoRoots(), { mode: 'every-repo', search: `?repo=${at(WORK, 'api')}&root=${WORK}` });
    await settle();
    await open('cross');
    await choose('web');
    expect(history.location.search).toBe(`?repo=${at(WORK, 'web')}&root=${WORK}&session=${CROSS}`);
    expect(viewName()).toBe('cross');
    await choose('docs');
    expect(history.location.search).toBe(`?repo=${at(WORK, 'docs')}&root=${WORK}`);
    expect(view()).toBeUndefined();
  });

  it('Main repo lists it under its main repo alone: blog keeps it, and web, under the other root, closes it', async () => {
    const first = renderDashboard(twoRoots(), { mode: 'main-repo', search: `?view=all&root=${PERSONAL}&session=${CROSS}` });
    await settle();
    await choose('blog');
    expect(first.history.location.search).toBe(`?repo=${at(PERSONAL, 'blog')}&root=${PERSONAL}&session=${CROSS}`);
    expect(viewName()).toBe('cross');
    first.unmount();

    const { history } = renderDashboard(twoRoots(), { mode: 'main-repo', search: `?repo=${at(WORK, 'api')}&root=${WORK}&session=${CROSS}` });
    await settle();
    expect(viewName()).toBe('cross');
    await choose('web');
    expect(history.location.search).toBe(`?repo=${at(WORK, 'web')}&root=${WORK}`);
    expect(view()).toBeUndefined();
  });

  it('a root tab change brings back the session its tab had open, as before', async () => {
    const { history } = renderDashboard(twoRoots(), { mode: 'where-started', search: `?repo=${at(WORK, 'api')}&root=${WORK}` });
    await settle();
    await open('in-api');
    fireEvent.click(tab('personal'));
    await settle();
    expect(view()).toBeUndefined();
    fireEvent.click(tab('work'));
    await settle();
    expect(history.location.search).toBe(`?repo=${at(WORK, 'api')}&root=${WORK}&session=${IN_API}`);
    expect(viewName()).toBe('in-api');
  });
});
