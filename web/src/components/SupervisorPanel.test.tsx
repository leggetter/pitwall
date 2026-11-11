// The supervisor's panel (W177, W187; docs/design-system.md, 4: Supervisor): ?supervisor added beside
// ?session= or ?pr=, never in their place; the open view stays, and the panel stays open as the
// selection, the open session or the root tab changes; its heading focused on open, focus back to what
// opened it on close, and Escape its first, wherever focus is. From 1,200 px it's a column of its own,
// a complementary landmark, which pushes the others left and covers nothing, folding the repo list into
// the header's Repos drawer below 1,520 px (W187); below 1,200 px, a non-modal dialog with no focus
// trap over the view over the list, which is inert under it, and a session opened from the panel
// closes it, in the same entry. Made-up sessions, ids and text only.

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IndexSnapshot, SupervisorState } from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import { BACKGROUND_TAB_KEY } from '../backgroundTab.js';
import type { StorageSource } from '../groupState.js';
import { group, minutesAgo, session, snapshot, withoutSubagents } from '../test/fixtures.js';
import { fakeHistory } from '../test/history.js';
import stylesCss from '../styles.css?raw';
import { tokens, withoutComments } from '../test/css.js';
import { Dashboard } from './Dashboard.js';
import { PANEL_KEEPS_REPOS, panelMax, panelMin, supervisorColumn } from '../panelWidth.js';

const ROOT = '/Users/example/code';
const OSS = '/Users/example/oss';
const alpha = session({ sessionId: '00000000-0000-4000-8000-00000000a177', name: 'pitwall-test-alpha', status: 'waiting', cwd: `${ROOT}/demo-app` });
const beta = session({ sessionId: '00000000-0000-4000-8000-00000000b177', name: 'pitwall-test-beta', cwd: `${ROOT}/docs` });
const blog = session({ sessionId: '00000000-0000-4000-8000-00000000c177', name: 'pitwall-test-blog', cwd: `${OSS}/blog` });

const idle: SupervisorState = { status: 'idle', approvals: [] };
const withHandoff: SupervisorState = { status: 'idle', approvals: [], handoffs: [{ id: 'h0', kind: 'message', name: beta.name, sessionId: beta.sessionId, at: minutesAgo(1) }] };

function snap(supervisor: SupervisorState | undefined = idle, roots: 1 | 2 = 1): IndexSnapshot {
  const groups = [group({ key: `${ROOT}/demo-app`, label: 'demo-app', sessions: [alpha] }), group({ key: `${ROOT}/docs`, label: 'docs', sessions: [beta] })];
  if (roots === 2) groups.push(group({ key: `${OSS}/blog`, label: 'blog', root: OSS, sessions: [blog] }));
  return snapshot(groups, { roots: roots === 2 ? [ROOT, OSS] : [ROOT], ...(supervisor ? { supervisor } : {}) });
}

function memory(entries: Record<string, string> = {}): StorageSource {
  const values = new Map(Object.entries(entries));
  return () => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) });
}

/** The supervisor's conversation is new, a 404; a session's is one made-up reply; nothing is POSTed. */
function fakeServer() {
  return vi.fn<FetchLike>(async (url, init) => {
    if (init.method === 'POST') return new Response(JSON.stringify({ ok: false, error: 'not in this test' }), { status: 409 });
    if (url.startsWith('/api/supervisor')) return new Response('{}', { status: 404 });
    const sessionId = decodeURIComponent(url.split('/')[3] ?? '');
    return new Response(JSON.stringify({ sessionId, entries: [{ kind: 'assistant', text: 'a made-up reply' }] }), { status: 200 });
  });
}

function renderDashboard(first: IndexSnapshot, search = '?view=all') {
  const history = fakeHistory(search);
  const api = createApiClient({ apiKey: 'k'.repeat(43), fetch: withoutSubagents(fakeServer()) });
  const storage = memory({ [BACKGROUND_TAB_KEY]: 'conversation' });
  const ui = (s: IndexSnapshot) => (
    <ApiContext.Provider value={api}>
      <Dashboard view={{ state: 'live', snapshot: s }} navigation={history.navigation} storage={storage} />
    </ApiContext.Provider>
  );
  const result = render(ui(first));
  return { ...result, history };
}

const settle = () => act(async () => {});
function setWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}
/** Lets a frame pass, for focus that waits for one below 1,200 px. */
const nextFrame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
});

const repoList = () => screen.getByRole('navigation', { name: 'Repos' });
/** The repo list as a column, not in the drawer. */
const repoColumn = () => document.querySelector('.columns > .repo-list') ?? undefined;
const reposButton = () => screen.queryByRole('button', { name: 'Repos' }) ?? undefined;
/** The header's Supervisor button (W182), which opens the panel. */
const item = () => document.querySelector<HTMLButtonElement>('header button[data-supervisor-button]')!;
const groupItem = (label: string) => [...repoList().querySelectorAll<HTMLAnchorElement>('a[data-repo-item]')].find((link) => link.querySelector('.repo-item-label')?.textContent === label)!;
const panel = () => document.getElementById('supervisor-view') ?? undefined;
const panelHeading = () => within(panel()!).getByRole('heading', { level: 2, name: 'Supervisor' });
const sessionView = () => document.getElementById('session-view') ?? undefined;
const sessionName = () => sessionView()?.querySelector('.session-view-name')?.textContent;
const pane = () => document.querySelector<HTMLElement>('.session-pane')!;
const paneViews = () => document.querySelector<HTMLElement>('.pane-views')!;
const row = (name: string) => screen.getByRole('button', { name });
async function click(element: Element) {
  fireEvent.click(element);
  await settle();
}
const escape = async (on: Element = document.activeElement ?? document.body) => {
  fireEvent.keyDown(on, { key: 'Escape' });
  await settle();
};

describe('from 1,200 px: beside the open session, which stays', () => {
  it('adds ?supervisor to the URL in one pushed entry, the session view still open and usable', async () => {
    setWidth(1440);
    const { history } = renderDashboard(snap());
    await click(row(beta.name));
    await click(item());
    expect(history.entries).toEqual(['?view=all', `?view=all&session=${beta.sessionId}`, `?view=all&session=${beta.sessionId}&supervisor`]);
    expect(sessionName()).toBe(beta.name);
    expect(panel()).toBeDefined();
    expect(pane().hasAttribute('data-panel-open')).toBe(true);
    expect(paneViews().inert).toBe(false);
    // A column beside the view, not over it (W187): a complementary landmark, named by its heading, which takes focus.
    expect(panel()!.getAttribute('role')).toBe('complementary');
    expect(panel()!.hasAttribute('aria-modal')).toBe(false);
    expect(panel()!.getAttribute('aria-labelledby')).toBe(panelHeading().id);
    expect(screen.getByRole('complementary', { name: 'Supervisor' })).toBe(panel());
    // The header's button opens no dialog here: a disclosure, expanded, controlling the panel.
    expect([item().getAttribute('aria-haspopup'), item().getAttribute('aria-expanded'), item().getAttribute('aria-controls')]).toEqual([null, 'true', 'supervisor-view']);
    expect(document.activeElement).toBe(panelHeading());
    // The session view isn't a dialog in the third column, and comes before the panel in the page.
    expect(sessionView()!.getAttribute('role')).toBeNull();
    expect(sessionView()!.compareDocumentPosition(panel()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('stays open as another session opens beside it, and as the selection changes', async () => {
    setWidth(1920);
    const { history } = renderDashboard(snap(), '?view=all&supervisor');
    await settle();
    await click(row(alpha.name));
    expect(history.location.search).toBe(`?view=all&session=${alpha.sessionId}&supervisor`);
    expect([sessionName(), panel() !== undefined]).toEqual([alpha.name, true]);
    // A group that doesn't list the session closes its view (W139), not the panel.
    await click(groupItem('docs'));
    expect(history.location.search).toBe(`?repo=${ROOT}/docs&supervisor`);
    expect([sessionView(), panel() !== undefined]).toEqual([undefined, true]);
    await click(row(beta.name));
    expect(history.location.search).toBe(`?repo=${ROOT}/docs&session=${beta.sessionId}&supervisor`);
    // The back button goes back through them with the panel open in each.
    history.back();
    await settle();
    expect([sessionView(), panel() !== undefined]).toEqual([undefined, true]);
  });

  it('stays open as the root tab changes: it is over the page, not a tab’s', async () => {
    setWidth(1440);
    const { history } = renderDashboard(snap(idle, 2), `?view=all&root=${ROOT}&supervisor`);
    await settle();
    fireEvent.click(screen.getByRole('tab', { name: /oss/ }));
    await settle();
    expect(history.location.search).toBe(`?view=all&root=${OSS}&supervisor`);
    expect(panel()).toBeDefined();
  });

  it('Escape closes it first, wherever focus is, then the session view’s own Escape is back', async () => {
    setWidth(1440);
    const { history } = renderDashboard(snap());
    await click(row(beta.name));
    await click(item());
    // Focus in the session view: still the panel's, the top layer.
    sessionView()!.querySelector<HTMLElement>('h2')!.focus();
    await escape();
    expect(panel()).toBeUndefined();
    expect(sessionName()).toBe(beta.name);
    expect(history.location.search).toBe(`?view=all&session=${beta.sessionId}`);
    await escape();
    expect(sessionView()).toBeUndefined();
  });

  it('Close gives focus back to what opened it: the header’s button, or Needs you’s Open the supervisor', async () => {
    setWidth(1440);
    renderDashboard(snap({ status: 'idle', approvals: [{ id: 'a1', kind: 'message', to: beta.name, text: 'A made-up message.', at: minutesAgo(1), expiresAt: minutesAgo(-28) }] }), '?view=needs-you');
    await settle();
    const notice = screen.getByRole('button', { name: 'Open the supervisor' });
    notice.focus();
    await click(notice);
    expect(document.activeElement).toBe(panelHeading());
    await click(within(panel()!).getByRole('button', { name: 'Close' }));
    expect(panel()).toBeUndefined();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open the supervisor' }));
    item().focus();
    await click(item());
    await click(within(panel()!).getByRole('button', { name: 'Close' }));
    expect(document.activeElement).toBe(item());
  });

  it('a session opened from it opens beside it, the panel kept, with focus on the session’s heading', async () => {
    setWidth(1440);
    const { history } = renderDashboard(snap(withHandoff), '?view=all&supervisor');
    await settle();
    await click(within(panel()!).getByRole('button', { name: `Open ${beta.name}` }));
    expect(history.location.search).toBe(`?view=all&session=${beta.sessionId}&supervisor`);
    expect([sessionName(), panel() !== undefined]).toEqual([beta.name, true]);
    expect(document.activeElement).toBe(sessionView()!.querySelector('h2'));
  });
});


describe('from 1,200 px, a column of its own (W187): the others give way, the repo list folding below 1,520 px', () => {
  it('works out the same room as styles.css: the panel 560 px, then down to 360 px, and the repo list folded below 1,520 px', () => {
    expect(PANEL_KEEPS_REPOS).toBe(1520);
    expect(supervisorColumn(1920)).toEqual({ repos: 240, panel: 560 });
    expect(supervisorColumn(1720)).toEqual({ repos: 240, panel: 560 });
    expect(supervisorColumn(1600)).toEqual({ repos: 240, panel: 440 });
    expect(supervisorColumn(1520)).toEqual({ repos: 240, panel: 360 });
    expect(supervisorColumn(1440)).toEqual({ repos: 0, panel: 520 });
    expect(supervisorColumn(1200)).toEqual({ repos: 0, panel: 360 });
    // What's left for the view: 760 px at 1,920, 560 px from 1,280 up, and 480 px at 1,200.
    expect([1920, 1600, 1520, 1440, 1280, 1200].map((width) => panelMax(width, true))).toEqual([760, 560, 560, 560, 560, 480]);
    expect([panelMin(1440, true), panelMin(1200, true), panelMin(1200)]).toEqual([560, 480, 560]);
    // Without the panel, as before.
    expect(panelMax(1440)).toBe(840);
  });

  it('at 1,440 px folds the repo list into the header’s Repos drawer while it’s open, and gives it back as it closes', async () => {
    setWidth(1440);
    const { history } = renderDashboard(snap());
    await click(row(beta.name));
    expect([repoColumn() !== undefined, reposButton()]).toEqual([true, undefined]);
    await click(item());
    expect(document.querySelector('.app')!.getAttribute('data-repos')).toBe('folded');
    expect([repoColumn(), reposButton() !== undefined]).toEqual([undefined, true]);
    // Nothing is covered, so nothing is inert.
    expect(paneViews().inert).toBe(false);
    expect(document.querySelector('.session-list')!.closest('[inert]')).toBeNull();
    // The drawer opens from the header, and choosing in it keeps the panel open.
    await click(reposButton()!);
    await click(groupItem('docs'));
    expect(history.location.search).toBe(`?repo=${ROOT}/docs&session=${beta.sessionId}&supervisor`);
    expect(panel()).toBeDefined();
    expect(document.querySelector('.repo-drawer')).toBeNull();
    await click(item());
    expect(panel()).toBeUndefined();
    expect([repoColumn() !== undefined, reposButton(), document.querySelector('.app')!.hasAttribute('data-repos')]).toEqual([true, undefined, false]);
  });

  it('keeps the repo list from 1,520 px', async () => {
    setWidth(1520);
    renderDashboard(snap(), '?view=all&supervisor');
    await settle();
    expect([panel() !== undefined, repoColumn() !== undefined, reposButton()]).toEqual([true, true, undefined]);
  });

  it('moves focus from the repo list to its heading as the back button folds the list away', async () => {
    setWidth(1440);
    const { history } = renderDashboard(snap());
    await click(item());
    await click(item());
    expect(panel()).toBeUndefined();
    groupItem('docs').focus();
    history.back();
    await settle();
    expect(panel()).toBeDefined();
    expect(repoColumn()).toBeUndefined();
    expect(document.activeElement).toBe(panelHeading());
  });

  it('the divider’s limits are what the column leaves, and what it sets is kept once the panel closes', async () => {
    setWidth(1920);
    renderDashboard(snap(), `?view=all&session=${beta.sessionId}`);
    await settle();
    const divider = () => screen.getByRole('separator', { name: 'Resize the session view' });
    expect([divider().getAttribute('aria-valuemin'), divider().getAttribute('aria-valuemax'), divider().getAttribute('aria-valuenow')]).toEqual(['560', '1320', '760']);
    await click(item());
    expect([divider().getAttribute('aria-valuemin'), divider().getAttribute('aria-valuemax'), divider().getAttribute('aria-valuenow')]).toEqual(['560', '760', '760']);
    fireEvent.keyDown(divider(), { key: 'ArrowRight' });
    await settle();
    expect(divider().getAttribute('aria-valuenow')).toBe('744');
    await click(item());
    expect([divider().getAttribute('aria-valuemax'), divider().getAttribute('aria-valuenow')]).toEqual(['1320', '744']);
  });

  it('a plain click on the divider, with no move, saves nothing: a wider width asked for stays once the panel closes', async () => {
    setWidth(1920);
    const writes: [string, string][] = [];
    const history = fakeHistory(`?view=all&session=${beta.sessionId}`);
    const api = createApiClient({ apiKey: 'k'.repeat(43), fetch: withoutSubagents(fakeServer()) });
    const values = new Map([[BACKGROUND_TAB_KEY, 'conversation'], ['pitwall.panel-width.v1', '1000']]);
    const storage: StorageSource = () => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { writes.push([key, value]); values.set(key, value); } });
    render(
      <ApiContext.Provider value={api}>
        <Dashboard view={{ state: 'live', snapshot: snap() }} navigation={history.navigation} storage={storage} />
      </ApiContext.Provider>,
    );
    await settle();
    const divider = () => screen.getByRole('separator', { name: 'Resize the session view' });
    expect(divider().getAttribute('aria-valuenow')).toBe('1000');
    await click(item());
    expect(divider().getAttribute('aria-valuenow')).toBe('760');
    fireEvent.pointerDown(divider(), { button: 0, clientX: 900, pointerId: 1 });
    fireEvent.pointerMove(divider(), { clientX: 900, pointerId: 1 });
    fireEvent.pointerUp(divider(), { clientX: 900, pointerId: 1 });
    await settle();
    expect(writes.filter(([key]) => key === 'pitwall.panel-width.v1')).toEqual([]);
    await click(item());
    expect(divider().getAttribute('aria-valuenow')).toBe('1000');
    // A drag that moves does save, the width shown then.
    await click(item());
    fireEvent.pointerDown(divider(), { button: 0, clientX: 900, pointerId: 1 });
    fireEvent.pointerMove(divider(), { clientX: 932, pointerId: 1 });
    fireEvent.pointerUp(divider(), { clientX: 932, pointerId: 1 });
    await settle();
    expect(writes.filter(([key]) => key === 'pitwall.panel-width.v1')).toEqual([['pitwall.panel-width.v1', '728']]);
  });
});

describe('below 1,200 px: over the view over the list', () => {
  it('covers the session view, which is inert under it, and Close gives it back', async () => {
    setWidth(1024);
    const { history } = renderDashboard(snap());
    await click(row(beta.name));
    item().focus();
    await click(item());
    expect(history.location.search).toBe(`?view=all&session=${beta.sessionId}&supervisor`);
    expect(paneViews().inert).toBe(true);
    expect(panel()!.classList.contains('overlay')).toBe(true);
    // Over the page here: a non-modal dialog, which the header's button says it opens.
    expect([panel()!.getAttribute('role'), panel()!.getAttribute('aria-modal'), item().getAttribute('aria-haspopup')]).toEqual(['dialog', 'false', 'dialog']);
    expect(document.activeElement).toBe(panelHeading());
    await click(within(panel()!).getByRole('button', { name: 'Close' }));
    await nextFrame();
    expect(paneViews().inert).toBe(false);
    expect(sessionName()).toBe(beta.name);
    expect(document.activeElement).toBe(item());
  });

  it('opens beside a session from 900 to 999 px, where the repo list is inert under the view: the header isn’t (W182)', async () => {
    setWidth(950);
    const { history } = renderDashboard(snap());
    await click(row(beta.name));
    expect(repoList().closest('[inert]')).not.toBeNull();
    expect(item().closest('[inert]')).toBeNull();
    item().focus();
    await click(item());
    expect(history.location.search).toBe(`?view=all&session=${beta.sessionId}&supervisor`);
    expect(sessionName()).toBe(beta.name);
    expect(document.activeElement).toBe(panelHeading());
    await click(within(panel()!).getByRole('button', { name: 'Close' }));
    await nextFrame();
    expect(document.activeElement).toBe(item());
  });

  it('moves focus from the session view to its heading when it opens over it, as from the app strip', async () => {
    setWidth(1024);
    renderDashboard(snap({ status: 'held', approvals: [], error: 'A made-up hold.' }), `?view=all&session=${beta.sessionId}`);
    await settle();
    sessionView()!.querySelector<HTMLElement>('h2')!.focus();
    await click(screen.getByRole('button', { name: 'Open' }));
    expect(document.activeElement).toBe(panelHeading());
  });

  it('a session opened from it closes it, in the same pushed entry, so the session is in sight', async () => {
    setWidth(1024);
    const { history } = renderDashboard(snap(withHandoff), '?view=all&supervisor');
    await settle();
    await click(within(panel()!).getByRole('button', { name: `Open ${beta.name}` }));
    expect(history.entries).toEqual(['?view=all&supervisor', `?view=all&session=${beta.sessionId}`]);
    expect([sessionName(), panel()]).toEqual([beta.name, undefined]);
    expect(document.activeElement).toBe(sessionView()!.querySelector('h2'));
  });

  it('`/` closes both, in one entry, and puts focus in the filter', async () => {
    setWidth(1024);
    const { history } = renderDashboard(snap(), `?view=all&session=${beta.sessionId}&supervisor`);
    await settle();
    fireEvent.keyDown(document.body, { key: '/' });
    await settle();
    await nextFrame();
    expect(history.entries).toEqual([`?view=all&session=${beta.sessionId}&supervisor`, '?view=all']);
    expect([sessionView(), panel()]).toEqual([undefined, undefined]);
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: /Filter/ }));
  });

  it('at 600 px and narrower, Back says where it goes back to', async () => {
    setWidth(375);
    renderDashboard(snap(), `?view=all&session=${beta.sessionId}&supervisor`);
    await settle();
    expect(within(panel()!).getByRole('button', { name: 'Back to the session' })).toBeDefined();
  });
});

describe('its place in the design system', () => {
  it('below 1,200 px sits at --pw-z-supervisor, above the view over the list and below menus; from 1,200 px it is a column beside the view, over nothing (W187)', () => {
    const css = withoutComments(stylesCss);
    expect(css).toMatch(/\.session-view\.overlay\.view-panel\s*\{\s*z-index:\s*var\(--pw-z-supervisor\);/);
    expect(css).toMatch(/\.session-pane\[data-panel-open\]\s*\{\s*width:\s*calc\(var\(--pw-view-w\) \+ var\(--pw-supervisor-col\)\);/);
    const column = /\.app\[data-layout='three-columns'\] \.session-pane > \.session-view\.view-panel\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(column).toMatch(/flex:\s*none;/);
    expect(column).toMatch(/width:\s*var\(--pw-supervisor-col\);/);
    expect(column).not.toMatch(/position:\s*absolute|z-index|box-shadow/);
    const z = (name: string) => Number(new RegExp(`--pw-z-${name}:\\s*(\\d+);`).exec(tokens)?.[1]);
    expect(z('panel')).toBeLessThan(z('supervisor'));
    expect(z('supervisor')).toBeLessThan(z('dropdown'));
  });
});
