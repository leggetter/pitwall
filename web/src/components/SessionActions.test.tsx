import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { removePath, stopPath, type IndexSnapshot, type SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import type { ConnectionView } from '../connection.js';
import { group, NOW, session, snapshot } from '../test/fixtures.js';
import stylesCss from '../styles.css?raw';
import { block, declarations, withoutComments } from '../test/css.js';
import { toastMessages, toastSaying } from '../test/toasts.js';
import { descriptionOf } from '../test/tooltips.js';
import { Dashboard } from './Dashboard.js';

// Made-up sessions only.

const API_KEY = 'k'.repeat(43);
const BG = '00000000-0000-4000-8000-0000000000b1';
const INTERACTIVE = '00000000-0000-4000-8000-0000000000a1';

const STOP_TEXT = 'Stop this session?';
const STOP_CONSEQUENCE = 'Its conversation is kept. Attaching to it later asks before restarting it.';
const REMOVE_TEXT = 'Remove this session?';

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
    expect(within(interactive).getByRole('button', { name: /Typing \/bg in its terminal moves it to the background/ })).toBeTruthy();
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

    it('copies the session ID, says so in a toast, and puts focus back on the menu button', async () => {
      renderDashboard(fakeServer({ status: 200, body: { ok: true } }));
      const view = await openView('pitwall-test-bg');
      choose(view, 'Copy session ID');
      // Written inside the click, as Safari requires.
      expect(writeText).toHaveBeenCalledWith(BG);
      expect(within(view).queryByRole('menu')).toBeNull();
      expect(document.activeElement).toBe(within(view).getByRole('button', { name: 'Session actions' }));
      await settle();
      expect(toastMessages()).toEqual(['Copied']);
      expect(toastSaying('Copied').className).toBe('toast success');
      // The view no longer says it itself.
      expect(view.querySelector('.session-view-copied')).toBeNull();
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
      // An error toast, which stays until dismissed, and the text on screen, selected.
      expect(toastMessages()).toEqual(["Couldn't copy; the text is selected"]);
      expect(toastSaying("Couldn't copy; the text is selected").getAttribute('role')).toBe('alert');
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
    const confirm = within(view).getByRole('group', { name: STOP_TEXT, description: STOP_CONSEQUENCE });
    expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: 'Cancel' }));
    // Cancel, then the confirm button, which repeats the question's verb and object.
    expect(within(confirm).getAllByRole('button').map((button) => button.textContent)).toEqual(['Cancel', 'Stop session']);
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

  it('stops the session once confirmed, and says so in a toast', async () => {
    const server = fakeServer({ status: 200, body: { ok: true } });
    renderDashboard(server);
    const view = await openView('pitwall-test-bg');
    choose(view, 'Stop session');
    fireEvent.click(within(view).getByRole('button', { name: 'Stop session' }));
    await settle();

    expect(postedUrls(server)).toEqual([stopPath(BG)]);
    const call = server.mock.calls.find(([, init]) => init.method === 'POST');
    expect((call?.[1].headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
    expect(toastMessages()).toEqual(['Stopped. Its conversation is kept.']);
    // Not in the confirmation's place any more.
    expect(view.querySelector('.session-actions')).toBeNull();
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
    expect(descriptionOf(stop)).toMatch(/isn't running/);
    // Activating it does nothing, and the menu stays open.
    fireEvent.click(stop);
    expect(within(view).queryByRole('group')).toBeNull();
    expect(within(view).getByRole('menu')).toBeTruthy();
    expect(item(view, 'Remove session').hasAttribute('aria-disabled')).toBe(false);
    expect(postedUrls(server)).toEqual([]);
  });

  it('asks before removing, then removes the session, closes its view and says so in a toast', async () => {
    const server = fakeServer({ status: 200, body: { ok: true } });
    renderDashboard(server);
    const view = await openView('pitwall-test-bg');
    choose(view, 'Remove session');
    expect(within(view).getByRole('group', { name: REMOVE_TEXT })).toBeTruthy();
    fireEvent.click(within(view).getByRole('button', { name: 'Remove session' }));
    await settle();

    expect(postedUrls(server)).toEqual([removePath(BG)]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(toastMessages()).toEqual(['Removed pitwall-test-bg']);
  });

  it("shows Claude Code's message when it refuses, and keeps the view open", async () => {
    const refusal = "Kept the worktree pitwall-test-wt: it has 2 unpushed commits.\nTo discard them, run 'claude rm b3899da0 --discard-unpushed 1a2b3c@pitwall-test-wt'.";
    renderDashboard(fakeServer({ status: 409, body: { ok: false, error: refusal } }, { status: 502 }));
    const view = await openView('pitwall-test-bg');
    choose(view, 'Remove session');
    fireEvent.click(within(view).getByRole('button', { name: 'Remove session' }));
    await settle();

    // pitwall's sentence, then Claude Code's message in code style, as text.
    const alert = within(view).getByRole('alert');
    expect(alert.textContent).toBe(`Couldn't remove the session. ${refusal}`);
    expect(alert.querySelector('.alert-detail')?.textContent).toBe(refusal);
    expect(alert.className).toContain('danger');
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
    // The confirm button is busy, in the confirmation, which stays; Cancel is aria-disabled.
    const confirm = within(view).getByRole('group', { name: STOP_TEXT });
    const busy = within(confirm).getByRole('button', { name: 'Stopping…' });
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.querySelector('.spinner')).toBeTruthy();
    expect(within(confirm).getByRole('button', { name: 'Cancel' }).getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(busy);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(busy, { key: 'Escape' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(within(view).getByRole('group', { name: STOP_TEXT })).toBe(confirm);
    expect(screen.getByRole('dialog', { name: 'pitwall-test-bg' })).toBe(view);
    openMenu(view);
    expect(item(view, 'Stop session').getAttribute('aria-disabled')).toBe('true');
    expect(item(view, 'Remove session').getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(item(view, 'Remove session'));
    expect(within(view).getByRole('group', { name: STOP_TEXT })).toBeTruthy();
    expect(server.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    answer(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await settle();
    expect(toastMessages()).toEqual(['Stopped. Its conversation is kept.']);
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

/** A server whose POSTs wait until released with an answer; GETs get an empty page at once. */
function heldServer() {
  const waiting: ((answer: Answer) => void)[] = [];
  const fetch = vi.fn<FetchLike>(async (url, init) => {
    if (init.method !== 'POST') {
      const sessionId = decodeURIComponent(/\/api\/sessions\/([^/]+)\//.exec(url)?.[1] ?? '');
      return new Response(JSON.stringify({ sessionId, entries: [] }), { status: 200 });
    }
    const answer = await new Promise<Answer>((resolve) => waiting.push(resolve));
    return new Response(answer.body === undefined ? 'not json' : JSON.stringify(answer.body), { status: answer.status });
  });
  const release = async (answer: Answer) => {
    const next = waiting.shift();
    if (!next) throw new Error('no POST is waiting');
    await act(async () => next(answer));
    await settle();
  };
  return { fetch, release };
}

describe('a result that arrives after the view has gone (W31)', () => {
  const viewName = () => document.querySelector('#session-view .session-view-name')?.textContent;
  const press = (key: string, target: Element) => act(() => void fireEvent.keyDown(target, { key }));

  it('j, k, ↑ and ↓ do nothing while a Stop runs, so they never move the view away from it', async () => {
    const { fetch, release } = heldServer();
    renderDashboard(fetch);
    const view = await openView('pitwall-test-bg');
    choose(view, 'Stop session');
    fireEvent.click(within(view).getByRole('button', { name: 'Stop session' }));
    await settle();
    const heading = view.querySelector<HTMLElement>('.session-view-title')!;
    heading.focus();
    for (const key of ['j', 'k', 'ArrowDown', 'ArrowUp']) press(key, heading);
    await settle();
    expect(viewName()).toBe('pitwall-test-bg');
    expect(within(view).getByRole('button', { name: 'Stopping…' })).toBeTruthy();

    await release({ status: 200, body: { ok: true } });
    expect(toastMessages()).toEqual(['Stopped. Its conversation is kept.']);
    // Done, they move again: the interactive session is the row before.
    press('k', view.querySelector<HTMLElement>('.session-view-title')!);
    await settle();
    expect(viewName()).toBe('pitwall-test-interactive');
  });

  it('says a Stop finished, naming the session, when its view was closed while it ran', async () => {
    const { fetch, release } = heldServer();
    renderDashboard(fetch);
    const view = await openView('pitwall-test-bg');
    choose(view, 'Stop session');
    fireEvent.click(within(view).getByRole('button', { name: 'Stop session' }));
    await settle();
    fireEvent.click(within(view).getByRole('button', { name: 'Close' }));
    await settle();
    expect(document.getElementById('session-view')).toBeNull();

    await release({ status: 200, body: { ok: true } });
    expect(toastMessages()).toEqual(['Stopped pitwall-test-bg. Its conversation is kept.']);
  });

  it("turns a refusal into an error toast with Claude Code's message, as text, when the view has gone", async () => {
    const refusal = 'Kept the worktree pitwall-test-wt: it has 2 unpushed commits. <b>made up</b>';
    const { fetch, release } = heldServer();
    renderDashboard(fetch);
    const view = await openView('pitwall-test-bg');
    choose(view, 'Remove session');
    fireEvent.click(within(view).getByRole('button', { name: 'Remove session' }));
    await settle();
    fireEvent.click(within(view).getByRole('button', { name: 'Close' }));
    await settle();

    await release({ status: 409, body: { ok: false, error: refusal } });
    const message = `Couldn't remove pitwall-test-bg. ${refusal}`;
    expect(toastMessages()).toEqual([message]);
    const toast = toastSaying(message);
    expect(toast.getAttribute('role')).toBe('alert');
    expect(toast.querySelector('b')).toBeNull();
  });

  it('says a request with no answer it understands failed, with its status, naming the session', async () => {
    const { fetch, release } = heldServer();
    renderDashboard(fetch);
    const view = await openView('pitwall-test-bg');
    choose(view, 'Stop session');
    fireEvent.click(within(view).getByRole('button', { name: 'Stop session' }));
    await settle();
    fireEvent.click(within(view).getByRole('button', { name: 'Close' }));
    await settle();

    await release({ status: 502 });
    expect(toastMessages()).toEqual(["Couldn't stop pitwall-test-bg (HTTP 502)."]);
  });

  it('says a Remove finished when the view went while it ran, and keeps it closed', async () => {
    const { fetch, release } = heldServer();
    renderDashboard(fetch);
    const view = await openView('pitwall-test-bg');
    choose(view, 'Remove session');
    fireEvent.click(within(view).getByRole('button', { name: 'Remove session' }));
    await settle();
    fireEvent.click(within(view).getByRole('button', { name: 'Close' }));
    await settle();
    await release({ status: 200, body: { ok: true } });
    expect(toastMessages()).toEqual(['Removed pitwall-test-bg']);
    expect(document.getElementById('session-view')).toBeNull();
  });
});

describe('the confirmations’ left bar (W31)', () => {
  it('is --pw-danger-fg for Stop and Remove, the pair 2.5 checks at 3:1 on the muted fill, and --pw-warning-indicator for the restart', () => {
    const css = withoutComments(stylesCss);
    const shadow = (selector: RegExp) => Object.fromEntries(declarations(block(css, selector)))['box-shadow'];
    expect(shadow(/\n\.inline-confirm\.danger\s*\{/)).toBe('inset 3px 0 0 var(--pw-danger-fg), inset 0 0 0 1px var(--pw-border-strong)');
    expect(shadow(/\n\.inline-confirm\.warning\s*\{/)).toBe('inset 3px 0 0 var(--pw-warning-indicator), inset 0 0 0 1px var(--pw-border-strong)');
    expect(Object.fromEntries(declarations(block(css, /\n\.inline-confirm\s*\{/))).background).toBe('var(--pw-surface-muted)');
  });
});

describe('the confirmations’ focus and results (W24)', () => {
  it('puts focus back on the menu button once Stop has finished, and announces the result', async () => {
    renderDashboard(fakeServer({ status: 200, body: { ok: true } }));
    const view = await openView('pitwall-test-bg');
    choose(view, 'Stop session');
    const confirmButton = within(view).getByRole('button', { name: 'Stop session' });
    confirmButton.focus();
    fireEvent.click(confirmButton);
    await settle();
    expect(within(view).queryByRole('group')).toBeNull();
    expect(document.activeElement).toBe(within(view).getByRole('button', { name: 'Session actions' }));
    // Announced by the toasts' live region, as a success toast.
    const result = toastSaying('Stopped. Its conversation is kept.');
    expect(result.className).toBe('toast success');
    expect(result.closest('[aria-live="polite"]')).toBeTruthy();
  });

  it('puts focus back on the menu button after a refusal too, which is announced as an alert', async () => {
    renderDashboard(fakeServer({ status: 409, body: { ok: false, error: 'claude stop failed: made up for the test.' } }));
    const view = await openView('pitwall-test-bg');
    choose(view, 'Stop session');
    fireEvent.click(within(view).getByRole('button', { name: 'Stop session' }));
    await settle();
    expect(document.activeElement).toBe(within(view).getByRole('button', { name: 'Session actions' }));
    expect(within(view).getByRole('alert').textContent).toBe("Couldn't stop the session. claude stop failed: made up for the test.");
  });

  it('keeps the confirm button’s width while it’s busy', async () => {
    let answer: (response: Response) => void = () => {};
    const server = vi.fn<FetchLike>(async (_url, init) =>
      init.method === 'POST'
        ? new Promise<Response>((resolve) => (answer = resolve))
        : new Response(JSON.stringify({ sessionId: BG, entries: [] }), { status: 200 }),
    );
    renderDashboard(server);
    const view = await openView('pitwall-test-bg');
    // happy-dom has no layout, so give buttons the width a browser would, before the confirmation opens.
    vi.spyOn(HTMLButtonElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 117, 24));
    choose(view, 'Stop session');
    fireEvent.click(within(view).getByRole('button', { name: 'Stop session' }));
    await settle();
    expect(within(view).getByRole('button', { name: 'Stopping…' }).style.minWidth).toBe('117px');
    answer(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await settle();
  });

  it('opens a new confirmation with focus on its own Cancel, when another was open', async () => {
    renderDashboard(fakeServer({ status: 200, body: { ok: true } }));
    const view = await openView('pitwall-test-bg');
    choose(view, 'Stop session');
    choose(view, 'Remove session');
    const confirm = within(view).getByRole('group', { name: 'Remove this session?' });
    expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: 'Cancel' }));
  });
});
