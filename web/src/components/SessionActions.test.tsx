import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { removePath, stopPath, type IndexSnapshot, type SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import type { ConnectionView } from '../connection.js';
import { group, NOW, session, snapshot } from '../test/fixtures.js';
import { Dashboard } from './Dashboard.js';

// Made-up sessions only.

const API_KEY = 'k'.repeat(43);
const BG = '00000000-0000-4000-8000-0000000000b1';
const INTERACTIVE = '00000000-0000-4000-8000-0000000000a1';

const STOP_TEXT = 'Stops the session; its conversation is kept. Attaching to it later asks before restarting it.';
const REMOVE_TEXT = 'Removes it from the list. Claude Code keeps a worktree that has unpushed commits.';

function background(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return session({ sessionId: BG, name: 'pitwall-test-bg', kind: 'background', shortId: 'b3899da0', state: 'working', ...overrides });
}

function snap(bg: SessionSummary = background()): IndexSnapshot {
  return snapshot([group({ sessions: [bg, session({ sessionId: INTERACTIVE, name: 'pitwall-test-interactive' })] })]);
}

type Answer = { status: number; body?: unknown };

/** POSTs get the next answer; GETs (the conversation) get an empty page. */
function fakeServer(...answers: Answer[]) {
  let call = 0;
  return vi.fn<FetchLike>(async (url, init) => {
    if (init.method !== 'POST') {
      const sessionId = decodeURIComponent(/\/api\/sessions\/([^/]+)\//.exec(url)?.[1] ?? '');
      return new Response(JSON.stringify({ sessionId, entries: [] }), { status: 200 });
    }
    const answer = answers[Math.min(call, answers.length - 1)];
    call += 1;
    if (!answer) throw new Error('no answer');
    return new Response(answer.body === undefined ? 'not json' : JSON.stringify(answer.body), { status: answer.status });
  });
}

const postedUrls = (fetch: ReturnType<typeof fakeServer>) => fetch.mock.calls.filter(([, init]) => init.method === 'POST').map(([url]) => url);

function renderDashboard(fetch: FetchLike | undefined, first: IndexSnapshot = snap()) {
  const api = fetch ? createApiClient({ apiKey: API_KEY, fetch }) : undefined;
  const ui = (s: IndexSnapshot) => {
    const view: ConnectionView = { state: 'live', snapshot: s };
    return (
      <ApiContext.Provider value={api}>
        <Dashboard view={view} />
      </ApiContext.Provider>
    );
  };
  const result = render(ui(first));
  return { ...result, update: (next: IndexSnapshot) => result.rerender(ui(next)) };
}

const settle = () => act(async () => {});

async function openView(name: string): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name }));
  await settle();
  return screen.getByRole('dialog', { name });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

/** Opens the view's actions menu, and returns its items' names in order, with "—" for a separator. */
function openMenu(view: HTMLElement): string[] {
  fireEvent.click(within(view).getByRole('button', { name: 'Session actions' }));
  const menu = within(view).getByRole('menu', { name: 'Session actions' });
  return [...menu.children].map((child) => (child.getAttribute('role') === 'separator' ? '—' : (child.textContent ?? '')));
}

/** Chooses an item from the actions menu, as a click would. */
function choose(view: HTMLElement, label: string) {
  if (!within(view).queryByRole('menu')) openMenu(view);
  fireEvent.click(within(view).getByRole('menuitem', { name: label }));
}

const item = (view: HTMLElement, label: string) => within(view).getByRole('menuitem', { name: label });

describe('the actions menu', () => {
  it('has Copy session ID, Copy attach command, a separator, then Stop and Remove, for a background session', async () => {
    renderDashboard(fakeServer({ status: 200, body: { ok: true } }));
    const bg = await openView('pitwall-test-bg');
    expect(openMenu(bg)).toEqual(['Copy session ID', 'Copy attach command', '—', 'Stop session', 'Remove session']);
    expect(item(bg, 'Remove session').className).toContain('danger');
    expect(item(bg, 'Stop session').className).not.toContain('danger');
  });

  it('has only Copy session ID for an interactive session, which keeps its /bg note', async () => {
    renderDashboard(fakeServer({ status: 200, body: { ok: true } }));
    const interactive = await openView('pitwall-test-interactive');
    expect(openMenu(interactive)).toEqual(['Copy session ID']);
    expect(within(interactive).getByRole('img', { name: /Typing \/bg in its terminal moves it to the background/ })).toBeTruthy();
  });

  it('leaves out Copy attach command when the short id fails the shell-safety check', async () => {
    renderDashboard(fakeServer({ status: 200, body: { ok: true } }), snap(background({ shortId: '$(touch pitwall-test)' })));
    const bg = await openView('pitwall-test-bg');
    expect(openMenu(bg)).toEqual(['Copy session ID', '—', 'Stop session', 'Remove session']);
  });

  describe('copying', () => {
    let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
    beforeEach(() => {
      writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    });

    it('copies the session ID, says so, and puts focus back on the menu button', async () => {
      renderDashboard(fakeServer({ status: 200, body: { ok: true } }));
      const view = await openView('pitwall-test-bg');
      choose(view, 'Copy session ID');
      // Written inside the click, as Safari requires.
      expect(writeText).toHaveBeenCalledWith(BG);
      expect(within(view).queryByRole('menu')).toBeNull();
      expect(document.activeElement).toBe(within(view).getByRole('button', { name: 'Session actions' }));
      await settle();
      expect(view.querySelector('.session-view-copied')?.textContent).toBe('Copied');
      expect(view.querySelector('.session-view-copied')?.getAttribute('aria-live')).toBe('polite');
    });

    it("copies the attach command from attachCommand(), never the raw short id", async () => {
      renderDashboard(fakeServer({ status: 200, body: { ok: true } }));
      const view = await openView('pitwall-test-bg');
      choose(view, 'Copy attach command');
      expect(writeText).toHaveBeenCalledWith('claude attach b3899da0');
    });

    it('shows the text, selected, when the clipboard refuses', async () => {
      writeText.mockRejectedValue(new Error('not allowed'));
      renderDashboard(fakeServer({ status: 200, body: { ok: true } }));
      const view = await openView('pitwall-test-bg');
      choose(view, 'Copy attach command');
      await settle();
      expect(view.querySelector('.session-view-copied')?.textContent).toBe("Couldn't copy; the text is selected");
      expect(view.querySelector('.session-view-copy-fallback')?.textContent).toBe('Attach command: claude attach b3899da0');
      expect(window.getSelection()?.toString()).toBe('claude attach b3899da0');
    });
  });
});

describe('Stop and Remove', () => {
  it('are offered for a background session, and not for an interactive one', async () => {
    renderDashboard(fakeServer({ status: 200, body: { ok: true } }));
    const bg = await openView('pitwall-test-bg');
    openMenu(bg);
    expect(item(bg, 'Stop session')).toBeTruthy();
    expect(item(bg, 'Remove session')).toBeTruthy();

    const interactive = await openView('pitwall-test-interactive');
    openMenu(interactive);
    expect(within(interactive).queryByRole('menuitem', { name: 'Stop session' })).toBeNull();
    expect(within(interactive).queryByRole('menuitem', { name: 'Remove session' })).toBeNull();
  });

  it('asks before stopping, and Cancel or Escape leaves the session alone and the view open, with focus back on the menu button', async () => {
    const server = fakeServer({ status: 200, body: { ok: true } });
    renderDashboard(server);
    const view = await openView('pitwall-test-bg');
    const menuButton = within(view).getByRole('button', { name: 'Session actions' });

    choose(view, 'Stop session');
    const confirm = within(view).getByRole('group', { name: STOP_TEXT });
    expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(within(view).queryByRole('group')).toBeNull();
    expect(document.activeElement).toBe(menuButton);

    choose(view, 'Stop session');
    fireEvent.keyDown(within(view).getByRole('button', { name: 'Stop session' }), { key: 'Escape' });
    expect(within(view).queryByRole('group')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'pitwall-test-bg' })).toBe(view);
    expect(document.activeElement).toBe(menuButton);

    // Escape from elsewhere cancels the confirmation first, and only then closes the view.
    choose(view, 'Stop session');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(within(view).queryByRole('group')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'pitwall-test-bg' })).toBe(view);
    expect(postedUrls(server)).toEqual([]);
  });

  it('stops the session once confirmed, and says so', async () => {
    const server = fakeServer({ status: 200, body: { ok: true } });
    renderDashboard(server);
    const view = await openView('pitwall-test-bg');
    choose(view, 'Stop session');
    fireEvent.click(within(view).getByRole('button', { name: 'Stop session' }));
    await settle();

    expect(postedUrls(server)).toEqual([stopPath(BG)]);
    const call = server.mock.calls.find(([, init]) => init.method === 'POST');
    expect((call?.[1].headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
    expect(within(view).getByRole('status').textContent).toBe('Stopped. Its conversation is kept.');
  });

  it("can't stop a session that isn't running, but can remove it", async () => {
    const server = fakeServer({ status: 200, body: { ok: true } });
    renderDashboard(server, snap(background({ alive: false, state: 'stopped', pid: undefined, finished: true })));
    // Stopped with no process: finished, so it's in the collapsed Finished list, and keeps Remove.
    fireEvent.click(screen.getByRole('button', { name: 'Finished (1)', expanded: false }));
    const view = await openView('pitwall-test-bg');
    openMenu(view);
    const stop = item(view, 'Stop session');
    expect(stop.getAttribute('aria-disabled')).toBe('true');
    expect(stop.title).toMatch(/isn't running/);
    // Activating it does nothing, and the menu stays open.
    fireEvent.click(stop);
    expect(within(view).queryByRole('group')).toBeNull();
    expect(within(view).getByRole('menu')).toBeTruthy();
    expect(item(view, 'Remove session').hasAttribute('aria-disabled')).toBe(false);
    expect(postedUrls(server)).toEqual([]);
  });

  it('asks before removing, then removes the session and closes its view', async () => {
    const server = fakeServer({ status: 200, body: { ok: true } });
    renderDashboard(server);
    const view = await openView('pitwall-test-bg');
    choose(view, 'Remove session');
    expect(within(view).getByRole('group', { name: REMOVE_TEXT })).toBeTruthy();
    fireEvent.click(within(view).getByRole('button', { name: 'Remove session' }));
    await settle();

    expect(postedUrls(server)).toEqual([removePath(BG)]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it("shows Claude Code's message when it refuses, and keeps the view open", async () => {
    const refusal = "Kept the worktree pitwall-test-wt: it has 2 unpushed commits.\nTo discard them, run 'claude rm b3899da0 --discard-unpushed 1a2b3c@pitwall-test-wt'.";
    renderDashboard(fakeServer({ status: 409, body: { ok: false, error: refusal } }, { status: 502 }));
    const view = await openView('pitwall-test-bg');
    choose(view, 'Remove session');
    fireEvent.click(within(view).getByRole('button', { name: 'Remove session' }));
    await settle();

    expect(within(view).getByRole('alert').textContent).toBe(refusal);
    expect(screen.getByRole('dialog', { name: 'pitwall-test-bg' })).toBe(view);

    choose(view, 'Stop session');
    fireEvent.click(within(view).getByRole('button', { name: 'Stop session' }));
    await settle();
    expect(within(view).getByRole('alert').textContent).toBe("Couldn't stop the session (HTTP 502).");
  });

  it('shows the action in progress and allows nothing else meanwhile', async () => {
    let answer: (response: Response) => void = () => {};
    const server = vi.fn<FetchLike>(async (_url, init) =>
      init.method === 'POST'
        ? new Promise<Response>((resolve) => (answer = resolve))
        : new Response(JSON.stringify({ sessionId: BG, entries: [] }), { status: 200 }),
    );
    renderDashboard(server);
    const view = await openView('pitwall-test-bg');
    choose(view, 'Stop session');
    fireEvent.click(within(view).getByRole('button', { name: 'Stop session' }));
    await settle();
    expect(within(view).getByRole('status').textContent).toBe('Stopping…');
    openMenu(view);
    expect(item(view, 'Stop session').getAttribute('aria-disabled')).toBe('true');
    expect(item(view, 'Remove session').getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(item(view, 'Remove session'));
    expect(within(view).queryByRole('group')).toBeNull();
    answer(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await settle();
    expect(within(view).getByRole('status').textContent).toBe('Stopped. Its conversation is kept.');
    expect(item(view, 'Remove session').hasAttribute('aria-disabled')).toBe(false);
  });

  it('are not offered once the session is no longer listed', async () => {
    const { update } = renderDashboard(fakeServer({ status: 200, body: { ok: true } }));
    const view = await openView('pitwall-test-bg');
    update(snapshot([group({ sessions: [session({ sessionId: INTERACTIVE, name: 'pitwall-test-interactive' })] })]));
    await settle();
    expect(openMenu(view)).toEqual(['Copy session ID', 'Copy attach command']);
    expect(within(view).getByText(/no longer listed/)).toBeTruthy();
  });
});
