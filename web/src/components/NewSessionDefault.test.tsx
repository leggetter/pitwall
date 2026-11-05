// + New session's directory (W146, D27, Phil, 2026-11-05): the repo or directory selected in the repo
// list, never the open session's, since choosing a group can close the session (W139) and the repo
// list always has a selection. With a view selected (All sessions, Needs you, Starred, Pull
// requests), no directory is chosen. A group outside the roots or the open tab, or a not-cloned
// repo's, gives none either. Made-up sessions only, and a fake server: nothing here reaches a session.

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPAWN_PATH, type ConversationPage, type IndexSnapshot, type SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import { shortenHome as short } from '../format.js';
import { newSessionDirectory } from '../spawn.js';
import { group, minutesAgo, NOW, session, snapshot } from '../test/fixtures.js';
import { fakeHistory } from '../test/history.js';
import { Dashboard } from './Dashboard.js';

const API_KEY = 'k'.repeat(43);
const CODE = '/Users/example/code';
const DEMO = `${CODE}/demo-app`;
const API = `${CODE}/api-server`;
const NOTES = `${CODE}/notes`;
const WORKTREE = `${API}/.claude/worktrees/pitwall-test-wt`;
const id = (n: number) => `00000000-0000-4000-8000-0000001460${String(n).padStart(2, '0')}`;

const live = () => session({ sessionId: id(1), name: 'api-live', cwd: API, lastActivityAt: minutesAgo(5) });
const inWorktree = () => session({ sessionId: id(2), name: 'api-worktree', cwd: WORKTREE, lastActivityAt: minutesAgo(6) });
const demo = () => session({ sessionId: id(4), name: 'demo-live', cwd: DEMO, lastActivityAt: minutesAgo(1) });
const note = () => session({ sessionId: id(5), name: 'notes-live', cwd: NOTES, lastActivityAt: minutesAgo(2) });

const snap = (apiSessions: SessionSummary[] = [live(), inWorktree()]): IndexSnapshot =>
  snapshot([
    group({ key: DEMO, label: 'demo-app', sessions: [demo()] }),
    group({ key: API, label: 'api-server', sessions: apiSessions }),
    group({ key: NOTES, label: 'notes', kind: 'directory', sessions: [note()] }),
  ]);

/** GETs are an empty conversation page; a POST starts a session. */
function fakeServer() {
  return vi.fn<FetchLike>(async (url, init) => {
    if (init.method !== 'POST') {
      const sessionId = decodeURIComponent(url.split('/')[3] ?? '');
      const page: ConversationPage = { sessionId, entries: [] };
      return new Response(JSON.stringify(page), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, shortId: 'pt146001', name: 'api-follow-up' }), { status: 200 });
  });
}

function renderAt(search: string, first: IndexSnapshot = snap()) {
  const history = fakeHistory(search);
  const fetch = fakeServer();
  const api = createApiClient({ apiKey: API_KEY, fetch });
  const ui = (s: IndexSnapshot) => (
    <ApiContext.Provider value={api}>
      <Dashboard view={{ state: 'live', snapshot: s }} navigation={history.navigation} />
    </ApiContext.Provider>
  );
  const result = render(ui(first));
  return { fetch, update: (next: IndexSnapshot) => result.rerender(ui(next)) };
}

const settle = () => act(async () => {});
const dialog = () => screen.getByRole('dialog', { name: 'New session' });
/** Directory's field, which shows the chosen directory shortened, as its option reads. */
const directory = () => within(dialog()).getByRole('combobox', { name: 'Directory' }) as HTMLInputElement;
const prompt = () => within(dialog()).getByLabelText('First prompt') as HTMLTextAreaElement;
/** The options Directory offers, opening its list. */
const values = () => {
  fireEvent.click(directory());
  return within(within(dialog()).getByRole('listbox', { name: 'Directories' })).getAllByRole('option').map((option) => option.textContent);
};
const startButton = () => within(dialog()).getByRole('button', { name: 'Start session' });

async function openFromHeader() {
  fireEvent.click(screen.getByRole('button', { name: 'New session' }));
  await settle();
  return dialog();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('newSessionDirectory', () => {
  const roots = [CODE];
  it("is the selected repo's or directory's, at or under a root", () => {
    expect(newSessionDirectory({ repo: API }, roots)).toBe(API);
    expect(newSessionDirectory({ repo: NOTES, root: CODE }, roots)).toBe(NOTES);
    expect(newSessionDirectory({ repo: CODE }, roots)).toBe(CODE);
  });

  it('is undefined for a view, a not-cloned repo, or a group outside the roots or the open tab', () => {
    for (const view of ['all', 'needs-you', 'starred', 'prs'] as const) expect(newSessionDirectory({ view }, roots)).toBeUndefined();
    expect(newSessionDirectory({ repo: 'github.com/example/elsewhere' }, roots)).toBeUndefined();
    expect(newSessionDirectory({ repo: '/Users/example/elsewhere' }, roots)).toBeUndefined();
    expect(newSessionDirectory({ repo: '/Users/example/codebase' }, roots)).toBeUndefined();
    // With a root tab open (W38), only a directory in that tab.
    expect(newSessionDirectory({ repo: `${CODE}/oss/thing` }, [CODE, `${CODE}/oss`], CODE)).toBeUndefined();
    expect(newSessionDirectory({ repo: `${CODE}/oss/thing` }, [CODE, `${CODE}/oss`], `${CODE}/oss`)).toBe(`${CODE}/oss/thing`);
  });
});

describe('+ New session from the repo list (W146)', () => {
  it('starts in the selected repo, from the header button, with nothing else filled in', async () => {
    renderAt(`?repo=${API}`);
    await settle();
    await openFromHeader();
    expect(directory().value).toBe(short(API));
    expect(values().filter((value) => value === short(API))).toHaveLength(1);
    expect(prompt().value).toBe('');
    expect((within(dialog()).getByLabelText(/^Name/) as HTMLInputElement).value).toBe('');
  });

  it('starts in a selected directory that is not a repo, and n opens it the same; the start sends it', async () => {
    const { fetch } = renderAt(`?repo=${NOTES}`);
    await settle();
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => {
      fireEvent.keyDown(document.body, { key: 'n' });
    });
    await settle();
    expect(directory().value).toBe(short(NOTES));
    fireEvent.change(prompt(), { target: { value: 'A made-up first prompt.' } });
    fireEvent.click(startButton());
    await settle();
    const post = fetch.mock.calls.find(([url, init]) => url === SPAWN_PATH && init.method === 'POST');
    expect(post).toBeDefined();
    expect(JSON.parse(String(post?.[1].body)).cwd).toBe(NOTES);
  });

  it("takes the selected group's directory, not the open session's worktree", async () => {
    renderAt(`?repo=${API}&session=${id(2)}`);
    await settle();
    expect(document.getElementById('session-view')).toBeTruthy();
    await openFromHeader();
    expect(directory().value).toBe(short(API));
    expect(values()).not.toContain(short(WORKTREE));
  });

  it('takes the group selected, not the open one, after choosing another group', async () => {
    renderAt(`?repo=${API}&session=${id(1)}`);
    await settle();
    fireEvent.click(screen.getByRole('link', { name: /^demo-app/ }));
    await settle();
    await openFromHeader();
    expect(directory().value).toBe(short(DEMO));
  });

  it.each(['?view=all', `?view=all&session=${id(1)}`, '?view=starred', '?view=needs-you', '?view=prs'])('chooses no directory with a view selected (%s), and offers every one', async (search) => {
    renderAt(search);
    await settle();
    await openFromHeader();
    expect(directory().value).toBe('');
    expect(values()).toEqual(expect.arrayContaining([short(DEMO), short(API), short(NOTES)]));
  });

  it('starts nothing until a directory is chosen when none was', async () => {
    const { fetch } = renderAt('?view=all');
    await settle();
    await openFromHeader();
    fireEvent.change(prompt(), { target: { value: 'A made-up first prompt.' } });
    fireEvent.click(startButton());
    await settle();
    expect(within(dialog()).getByText('Choose a directory.')).toBeTruthy();
    expect(fetch.mock.calls.some(([url, init]) => url === SPAWN_PATH && init.method === 'POST')).toBe(false);
  });

  it('keeps the directory it opened with when the snapshot changes while it is open', async () => {
    const { update } = renderAt(`?repo=${API}`);
    await settle();
    await openFromHeader();
    update(snap([live()]));
    await settle();
    expect(directory().value).toBe(short(API));
  });
});
