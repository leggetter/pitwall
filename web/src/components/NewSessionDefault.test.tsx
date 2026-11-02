// + New session's directory (#139, D27): with a session open, the header button and `n` start in that
// session's directory, a worktree's added first to the choices; with none open, its directory gone,
// outside the roots or the open tab, or the session no longer listed, the dialog's first choice, as
// before. Nothing from the session's conversation goes in. Made-up sessions only, and a fake server:
// nothing here reaches a session.

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPAWN_PATH, type ConversationPage, type IndexSnapshot, type SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import { newSessionDirectory } from '../spawn.js';
import { group, minutesAgo, NOW, session, snapshot } from '../test/fixtures.js';
import { fakeHistory } from '../test/history.js';
import { Dashboard } from './Dashboard.js';

const API_KEY = 'k'.repeat(43);
const CODE = '/Users/example/code';
const DEMO = `${CODE}/demo-app`;
const API = `${CODE}/api-server`;
const WORKTREE = `${API}/.claude/worktrees/pitwall-test-wt`;
const id = (n: number) => `00000000-0000-4000-8000-0000001390${String(n).padStart(2, '0')}`;

const live = () => session({ sessionId: id(1), name: 'api-live', cwd: API, lastActivityAt: minutesAgo(5) });
const inWorktree = () => session({ sessionId: id(2), name: 'api-worktree', cwd: WORKTREE, lastActivityAt: minutesAgo(6) });
const gone = () => session({ sessionId: id(3), name: 'api-gone', cwd: `${API}/.claude/worktrees/pitwall-test-gone`, cwdMissing: true, lastActivityAt: minutesAgo(7) });
const demo = () => session({ sessionId: id(4), name: 'demo-live', cwd: DEMO, lastActivityAt: minutesAgo(1) });

const snap = (apiSessions: SessionSummary[] = [live(), inWorktree(), gone()]): IndexSnapshot =>
  snapshot([group({ key: DEMO, label: 'demo-app', sessions: [demo()] }), group({ key: API, label: 'api-server', sessions: apiSessions })]);

/** GETs are an empty conversation page; a POST starts a session. */
function fakeServer() {
  return vi.fn<FetchLike>(async (url, init) => {
    if (init.method !== 'POST') {
      const sessionId = decodeURIComponent(url.split('/')[3] ?? '');
      const page: ConversationPage = { sessionId, entries: [] };
      return new Response(JSON.stringify(page), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, shortId: 'pt139001', name: 'api-follow-up' }), { status: 200 });
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
const directory = () => within(dialog()).getByLabelText('Directory') as HTMLSelectElement;
const prompt = () => within(dialog()).getByLabelText('First prompt') as HTMLTextAreaElement;
const values = () => [...directory().options].map((option) => option.value);

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
  it("is the session's directory, at or under a root", () => {
    expect(newSessionDirectory(live(), roots)).toBe(API);
    expect(newSessionDirectory(inWorktree(), roots)).toBe(WORKTREE);
    expect(newSessionDirectory({ cwd: CODE }, roots)).toBe(CODE);
  });

  it('is undefined with no session, its directory gone, or outside the roots or the open tab', () => {
    expect(newSessionDirectory(undefined, roots)).toBeUndefined();
    expect(newSessionDirectory(gone(), roots)).toBeUndefined();
    expect(newSessionDirectory({ cwd: '/Users/example/elsewhere' }, roots)).toBeUndefined();
    expect(newSessionDirectory({ cwd: '/Users/example/codebase' }, roots)).toBeUndefined();
    // With a root tab open (W38), only a directory in that tab.
    expect(newSessionDirectory({ cwd: `${CODE}/oss/thing` }, [CODE, `${CODE}/oss`], CODE)).toBeUndefined();
    expect(newSessionDirectory({ cwd: `${CODE}/oss/thing` }, [CODE, `${CODE}/oss`], `${CODE}/oss`)).toBe(`${CODE}/oss/thing`);
  });
});

describe('+ New session with a session open (#139)', () => {
  it("starts in the session's directory, from the header button, with nothing else filled in", async () => {
    renderAt(`?view=all&session=${id(1)}`);
    await settle();
    await openFromHeader();
    expect(directory().value).toBe(API);
    expect(values()[0]).not.toBe(API);
    expect(values().filter((value) => value === API)).toHaveLength(1);
    expect(prompt().value).toBe('');
    expect((within(dialog()).getByLabelText(/^Name/) as HTMLInputElement).value).toBe('');
  });

  it("adds a worktree's directory, which no group has, first, and n opens it the same; the start sends it", async () => {
    const { fetch } = renderAt(`?view=all&session=${id(2)}`);
    await settle();
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => {
      fireEvent.keyDown(document.body, { key: 'n' });
    });
    await settle();
    expect(directory().value).toBe(WORKTREE);
    expect(values()[0]).toBe(WORKTREE);
    expect(directory().options[0]?.textContent).toContain('.claude/worktrees/pitwall-test-wt');
    fireEvent.change(prompt(), { target: { value: 'A made-up first prompt.' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Start session' }));
    await settle();
    const post = fetch.mock.calls.find(([url, init]) => url === SPAWN_PATH && init.method === 'POST');
    expect(post).toBeDefined();
    expect(JSON.parse(String(post?.[1].body)).cwd).toBe(WORKTREE);
  });

  it('starts where it did before with no session open', async () => {
    renderAt('?view=all');
    await settle();
    await openFromHeader();
    expect(directory().value).toBe(values()[0]);
    expect(values()).not.toContain(WORKTREE);
  });

  it("starts where it did before when the session's directory has gone", async () => {
    renderAt(`?view=all&session=${id(3)}`);
    await settle();
    await openFromHeader();
    expect(directory().value).toBe(values()[0]);
    expect(values()).not.toContain(gone().cwd);
  });

  it('starts where it did before once the session is no longer listed, since pitwall cannot tell whether its directory is there', async () => {
    const { update } = renderAt(`?view=all&session=${id(2)}`);
    await settle();
    update(snap([live(), gone()]));
    await settle();
    expect(document.getElementById('session-view')).toBeTruthy();
    await openFromHeader();
    expect(directory().value).toBe(values()[0]);
    expect(values()).not.toContain(WORKTREE);
  });

  it('keeps the directory it opened with when the snapshot changes while it is open', async () => {
    const { update } = renderAt(`?view=all&session=${id(1)}`);
    await settle();
    await openFromHeader();
    update(snap([live(), inWorktree()]));
    await settle();
    expect(directory().value).toBe(API);
  });
});
