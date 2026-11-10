// Opening a session from outside the list, the supervisor's Sent and started or a PR view's Sessions
// (W144, Phil, 2026-11-05): its root tab and a group that lists it come with it, in the one pushed
// history entry, so a single Back returns to where you were. A selection that already lists it is
// kept (W139's rule), and a session no group lists yet opens alone, as before. Focus goes to the
// view's heading, with no focus gesture (W57). Made-up sessions, PRs and paths only.

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationPage, IndexSnapshot, PullRequestList, PullRequestSummary, SessionSummary, SupervisorState } from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import { BACKGROUND_TAB_KEY } from '../backgroundTab.js';
import { GROUP_BY_KEY } from '../groupBy.js';
import type { StorageSource } from '../groupState.js';
import { group, minutesAgo, NOW, pr, prLink, prList, session, snapshot, withoutSubagents } from '../test/fixtures.js';
import { fakeHistory } from '../test/history.js';
import { Dashboard } from './Dashboard.js';

const WORK = '/Users/example/work';
const PERSONAL = '/Users/example/personal';
const at = (root: string, name: string) => `${root}/${name}`;
const id = (n: number) => `00000000-0000-4000-8000-0000001440${String(n).padStart(2, '0')}`;

// Sessions the supervisor started or messaged, and ones linked to a PR, across two roots.
const started = session({ sessionId: id(1), name: 'pitwall-test-started', kind: 'background', shortId: 'c0ffee44', cwd: at(WORK, 'api'), lastActivityAt: minutesAgo(1) });
const inWeb = session({ sessionId: id(2), name: 'pitwall-test-web', cwd: at(WORK, 'web'), lastActivityAt: minutesAgo(2) });
const inBlog = session({ sessionId: id(3), name: 'pitwall-test-blog', cwd: at(PERSONAL, 'blog'), lastActivityAt: minutesAgo(3) });
const notYet = id(9);

const post = placed(pr({ number: 7, repoLabel: 'example/blog', title: 'A made-up post' }, 30), at(PERSONAL, 'blog'));
function placed(each: PullRequestSummary, key: string): PullRequestSummary {
  return { ...each, place: { kind: 'cloned', root: PERSONAL, key, label: 'blog' } };
}
// The api session named the blog's PR in a reply; the blog session pushed to it.
const linkedApi = { ...started, prLinks: [prLink('mentioned', post, 1)] };
const linkedBlog = { ...inBlog, prLinks: [prLink('pushed', post, 2)] };

function twoRoots(supervisor?: SupervisorState, sessions: { api?: SessionSummary; blog?: SessionSummary } = {}): IndexSnapshot {
  return snapshot(
    [
      group({ key: at(WORK, 'api'), label: 'api', root: WORK, sessions: [sessions.api ?? started] }),
      group({ key: at(WORK, 'web'), label: 'web', root: WORK, sessions: [inWeb] }),
      group({ key: at(PERSONAL, 'blog'), label: 'blog', root: PERSONAL, sessions: [sessions.blog ?? inBlog] }),
    ],
    { roots: [WORK, PERSONAL], ...(supervisor ? { supervisor } : {}) },
  );
}

/** One root, `~/work` alone: api and web. */
function oneRoot(supervisor?: SupervisorState, api: SessionSummary = started): IndexSnapshot {
  return snapshot(
    [group({ key: at(WORK, 'api'), label: 'api', root: WORK, sessions: [api] }), group({ key: at(WORK, 'web'), label: 'web', root: WORK, sessions: [inWeb] })],
    { roots: [WORK], ...(supervisor ? { supervisor } : {}) },
  );
}

const handoffs = (...rows: { name: string; sessionId: string }[]): SupervisorState => ({
  status: 'idle',
  approvals: [],
  handoffs: rows.map((row, n) => ({ id: `h${n}`, kind: 'message', name: row.name, sessionId: row.sessionId, at: minutesAgo(n) })),
});
const spawned: SupervisorState = { status: 'idle', approvals: [], handoffs: [{ id: 'h1', kind: 'spawn', name: started.name, shortId: 'c0ffee44', at: minutesAgo(0) }] };

function memory(entries: Record<string, string> = {}): StorageSource {
  const values = new Map(Object.entries(entries));
  return () => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) });
}

/** Every GET is a conversation page of one entry, or a 404 for the supervisor's; every POST is refused. */
function fakeServer() {
  return vi.fn<FetchLike>(async (url, init) => {
    if (init.method === 'POST') return new Response(JSON.stringify({ ok: false, error: 'not in this test' }), { status: 409 });
    if (url.startsWith('/api/supervisor')) return new Response('{}', { status: 404 });
    const sessionId = decodeURIComponent(url.split('/')[3] ?? '');
    const page: ConversationPage = { sessionId, entries: [{ kind: 'assistant', text: 'a made-up reply' }] };
    return new Response(JSON.stringify(page), { status: 200 });
  });
}

function renderDashboard(first: IndexSnapshot, options: { search: string; prs?: PullRequestList }) {
  const history = fakeHistory(options.search);
  const api = createApiClient({ apiKey: 'k'.repeat(43), fetch: withoutSubagents(fakeServer()) });
  // Conversation first, so no running background session's view attaches.
  const storage = memory({ [BACKGROUND_TAB_KEY]: 'conversation', [GROUP_BY_KEY]: 'where-started' });
  const ui = (s: IndexSnapshot) => (
    <ApiContext.Provider value={api}>
      <Dashboard view={{ state: 'live', snapshot: s, ...(options.prs ? { prs: options.prs } : {}) }} navigation={history.navigation} storage={storage} />
    </ApiContext.Provider>
  );
  const result = render(ui(first));
  return { ...result, history, update: (next: IndexSnapshot) => result.rerender(ui(next)) };
}

const settle = () => act(async () => {});
function setWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

const repoList = () => screen.getByRole('navigation', { name: 'Repos' });
/** The repo list's selected item's label. */
const selected = () => repoList().querySelector('a[aria-current="page"] .repo-item-label')?.textContent;
const activeTab = () => screen.queryAllByRole('tab').find((candidate) => candidate.classList.contains('root-tab') && candidate.getAttribute('aria-selected') === 'true')?.textContent;
/** The shown session view: not the supervisor's, nor one kept hidden for another root tab (W38). */
const sessionView = () => [...document.querySelectorAll<HTMLElement>('section.session-view:not(#supervisor-view):not(#pr-view)')].find((view) => view.closest('[hidden]') === null);
const viewName = () => sessionView()?.querySelector('.session-view-name')?.textContent;
const supervisorView = () => document.getElementById('supervisor-view') ?? undefined;
const prView = () => document.getElementById('pr-view') ?? undefined;
const sentAndStarted = () => within(supervisorView()!).getByRole('region', { name: /Sent and started/ });
async function openFromHandoffs(name: string) {
  fireEvent.click(within(sentAndStarted()).getByRole('button', { name: `Open ${name}` }));
  await settle();
}
async function openFromPrView(name: string) {
  fireEvent.click(within(prView()!).getByRole('button', { name }));
  await settle();
}
/** Focus is on the open session view's heading. */
const headingFocused = () => document.activeElement?.tagName === 'H2' && document.activeElement.closest('section.session-view') === sessionView() && sessionView() !== undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  setWidth(1300);
});

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
});

describe("from the supervisor's Sent and started (W144)", () => {
  it("with root tabs: a session in the other root's tab opens there, under its group, in one pushed entry", async () => {
    const { history } = renderDashboard(twoRoots(spawned), { search: `?repo=${at(PERSONAL, 'blog')}&root=${PERSONAL}&supervisor` });
    await settle();
    expect(activeTab()).toContain('personal');
    await openFromHandoffs(started.name);
    expect(history.entries).toEqual([`?repo=${at(PERSONAL, 'blog')}&root=${PERSONAL}&supervisor`, `?repo=${at(WORK, 'api')}&root=${WORK}&session=${started.sessionId}&supervisor`]);
    expect(activeTab()).toContain('work');
    expect(selected()).toBe('api');
    expect(viewName()).toBe(started.name);
    // From 1,200 px the supervisor's panel stays open beside it (W177).
    expect(supervisorView()).toBeDefined();
    expect(headingFocused()).toBe(true);
  });

  it('one Back returns to the tab, the group and the supervisor, which is still usable', async () => {
    const { history } = renderDashboard(twoRoots(spawned), { search: `?repo=${at(PERSONAL, 'blog')}&root=${PERSONAL}&supervisor` });
    await settle();
    await openFromHandoffs(started.name);
    history.back();
    await settle();
    expect(history.location.search).toBe(`?repo=${at(PERSONAL, 'blog')}&root=${PERSONAL}&supervisor`);
    expect(activeTab()).toContain('personal');
    expect(selected()).toBe('blog');
    expect(sessionView()).toBeUndefined();
    // Its Open works again from there, with the panel still open beside the session (W177).
    await openFromHandoffs(started.name);
    expect(selected()).toBe('api');
    fireEvent.click(repoList().querySelector<HTMLAnchorElement>('a[data-supervisor-item]')!);
    await settle();
    expect(history.location.search).toBe(`?repo=${at(WORK, 'api')}&root=${WORK}&session=${started.sessionId}&supervisor`);
    expect(within(supervisorView()!).getByRole('textbox', { name: 'Message to the supervisor' })).toBeDefined();
  });

  it('with one root: a group that does not list it gives way to its group', async () => {
    const { history } = renderDashboard(oneRoot(handoffs({ name: started.name, sessionId: started.sessionId })), { search: `?repo=${at(WORK, 'web')}&supervisor` });
    await settle();
    await openFromHandoffs(started.name);
    expect(history.entries).toEqual([`?repo=${at(WORK, 'web')}&supervisor`, `?repo=${at(WORK, 'api')}&session=${started.sessionId}&supervisor`]);
    expect(selected()).toBe('api');
    expect(viewName()).toBe(started.name);
    expect(headingFocused()).toBe(true);
    history.back();
    await settle();
    expect(selected()).toBe('web');
    expect(supervisorView()).toBeDefined();
  });

  it('keeps a selection that already lists it: its group, or a view in its tab', async () => {
    const first = renderDashboard(oneRoot(handoffs({ name: started.name, sessionId: started.sessionId })), { search: `?repo=${at(WORK, 'api')}&supervisor` });
    await settle();
    await openFromHandoffs(started.name);
    expect(first.history.entries).toEqual([`?repo=${at(WORK, 'api')}&supervisor`, `?repo=${at(WORK, 'api')}&session=${started.sessionId}&supervisor`]);
    first.unmount();

    const { history } = renderDashboard(twoRoots(handoffs({ name: started.name, sessionId: started.sessionId })), { search: `?view=all&root=${WORK}&supervisor` });
    await settle();
    await openFromHandoffs(started.name);
    expect(history.entries).toEqual([`?view=all&root=${WORK}&supervisor`, `?view=all&root=${WORK}&session=${started.sessionId}&supervisor`]);
    expect(selected()).toBe('All sessions');
    expect(viewName()).toBe(started.name);
  });

  it("Starred, which doesn't list it, gives way to its group (W148)", async () => {
    const { history } = renderDashboard(oneRoot(handoffs({ name: started.name, sessionId: started.sessionId })), { search: '?view=starred&supervisor' });
    await settle();
    await openFromHandoffs(started.name);
    expect(history.entries).toEqual(['?view=starred&supervisor', `?repo=${at(WORK, 'api')}&session=${started.sessionId}&supervisor`]);
    expect(selected()).toBe('api');
    expect(viewName()).toBe(started.name);
  });

  it("a view in the other root's tab does not keep it", async () => {
    const { history } = renderDashboard(twoRoots(handoffs({ name: inWeb.name, sessionId: inWeb.sessionId })), { search: `?view=all&root=${PERSONAL}&supervisor` });
    await settle();
    await openFromHandoffs(inWeb.name);
    expect(history.location.search).toBe(`?repo=${at(WORK, 'web')}&root=${WORK}&session=${inWeb.sessionId}&supervisor`);
    expect(activeTab()).toContain('work');
    expect(selected()).toBe('web');
  });

  it('offers no Open for a session the index does not list yet, so nothing changes (selectionShowing() keeps the selection for one)', async () => {
    const { history } = renderDashboard(twoRoots(handoffs({ name: 'pitwall-test-later', sessionId: notYet })), { search: `?repo=${at(PERSONAL, 'blog')}&root=${PERSONAL}&supervisor` });
    await settle();
    expect(within(sentAndStarted()).getByText('Not listed')).toBeDefined();
    expect(within(sentAndStarted()).queryByRole('button', { name: 'Open pitwall-test-later' })).toBeNull();
    expect(history.entries).toEqual([`?repo=${at(PERSONAL, 'blog')}&root=${PERSONAL}&supervisor`]);
  });
});

describe("from a PR view's Sessions (W144)", () => {
  const prs = prList([post]);
  const prSearch = (selection: string) => `${selection}&pr=example/blog/7`;

  it("with root tabs: a session under the other root opens in its tab and group, in one pushed entry, and one Back returns to the PR", async () => {
    const start = prSearch(`?repo=${at(PERSONAL, 'blog')}&root=${PERSONAL}`);
    const { history } = renderDashboard(twoRoots(undefined, { api: linkedApi, blog: linkedBlog }), { search: start, prs });
    await settle();
    expect(prView()).toBeDefined();
    await openFromPrView(started.name);
    expect(history.entries).toEqual([start, `?repo=${at(WORK, 'api')}&root=${WORK}&session=${started.sessionId}`]);
    expect(activeTab()).toContain('work');
    expect(selected()).toBe('api');
    expect(viewName()).toBe(started.name);
    expect(prView()).toBeUndefined();
    expect(headingFocused()).toBe(true);
    history.back();
    await settle();
    expect(history.location.search).toBe(start);
    expect(activeTab()).toContain('personal');
    expect(selected()).toBe('blog');
    expect(prView()).toBeDefined();
  });

  it('keeps a group that already lists it', async () => {
    const start = prSearch(`?repo=${at(PERSONAL, 'blog')}&root=${PERSONAL}`);
    const { history } = renderDashboard(twoRoots(undefined, { api: linkedApi, blog: linkedBlog }), { search: start, prs });
    await settle();
    await openFromPrView(inBlog.name);
    expect(history.entries).toEqual([start, `?repo=${at(PERSONAL, 'blog')}&root=${PERSONAL}&session=${inBlog.sessionId}`]);
    expect(selected()).toBe('blog');
    expect(viewName()).toBe(inBlog.name);
  });

  it('with one root: Pull requests, a view, keeps it; a group that does not list it gives way', async () => {
    const one = oneRoot(undefined, linkedApi);
    const first = renderDashboard(one, { search: '?view=prs&pr=example/blog/7', prs });
    await settle();
    await openFromPrView(started.name);
    expect(first.history.location.search).toBe(`?view=prs&session=${started.sessionId}`);
    first.unmount();

    const { history } = renderDashboard(one, { search: prSearch(`?repo=${at(WORK, 'web')}`), prs });
    await settle();
    await openFromPrView(started.name);
    expect(history.entries).toEqual([prSearch(`?repo=${at(WORK, 'web')}`), `?repo=${at(WORK, 'api')}&session=${started.sessionId}`]);
    expect(selected()).toBe('api');
    history.back();
    await settle();
    expect(selected()).toBe('web');
    expect(prView()).toBeDefined();
  });
});
